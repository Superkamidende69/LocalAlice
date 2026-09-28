package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/mudler/LocalAI/core/config"
	"github.com/mudler/LocalAI/core/http/auth"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

var _ = Describe("saved chat HTTP routes", func() {
	It("requires auth and preserves generation after disconnect and a stale chat save", func() {
		dir, err := os.MkdirTemp("", "saved-chat-routes-")
		Expect(err).NotTo(HaveOccurred())
		defer os.RemoveAll(dir)
		app := echo.New()
		cfg := &config.ApplicationConfig{DataPath: dir, ApiKeys: []string{"test-secret"}}
		app.Use(auth.Middleware(nil, cfg))
		registerSharedChatRoutes(app, cfg)
		release := make(chan struct{})
		app.POST("/v1/chat/completions", func(c echo.Context) error {
			c.Response().Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintln(c.Response(), `data: {"choices":[{"delta":{"reasoning":"thinking only"}}]}`)
			c.Response().Flush()
			select {
			case <-release:
			case <-c.Request().Context().Done():
				return nil
			}
			fmt.Fprintln(c.Response(), `data: {"choices":[{"delta":{"content":"Saved final answer"},"finish_reason":"stop"}]}`)
			fmt.Fprintln(c.Response(), "data: [DONE]")
			return nil
		})
		request := func(method, path string, body any, key string) *httptest.ResponseRecorder {
			data, _ := json.Marshal(body)
			req := httptest.NewRequest(method, path, bytes.NewReader(data))
			req.Header.Set("Content-Type", "application/json")
			if key != "" {
				req.Header.Set("Authorization", "Bearer "+key)
			}
			rec := httptest.NewRecorder()
			app.ServeHTTP(rec, req)
			return rec
		}
		Expect(request("POST", "/api/chats/generate", map[string]any{}, "").Code).To(Equal(401))
		chat := map[string]any{"id": "test-chat", "model": "test-model", "history": []any{map[string]any{"role": "user", "content": "hello"}}, "updatedAt": 1}
		payload := map[string]any{"id": "test-generation", "chat": chat, "endpoint": "/v1/chat/completions", "request": map[string]any{"model": "test-model", "messages": chat["history"]}}
		data, _ := json.Marshal(payload)
		ctx, cancel := context.WithCancel(context.Background())
		req := httptest.NewRequest("POST", "/api/chats/generate", bytes.NewReader(data)).WithContext(ctx)
		req.Header.Set("Authorization", "Bearer test-secret")
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, req)
		Expect(rec.Code).To(Equal(202), rec.Body.String())
		cancel() // the browser connection is gone
		getChat := func() map[string]any {
			response := request("GET", "/api/chats", nil, "test-secret")
			var result map[string]any
			Expect(json.Unmarshal(response.Body.Bytes(), &result)).To(Succeed())
			return result["chats"].([]any)[0].(map[string]any)
		}
		Eventually(func() int { return len(getChat()["history"].([]any)) }, 3*time.Second).Should(Equal(2))
		Expect(request("PUT", "/api/chats", map[string]any{"chats": []any{chat}}, "test-secret").Code).To(Equal(200))
		Expect(getChat()["generationStatus"]).To(Equal("running"))
		close(release)
		Eventually(func() any { return getChat()["generationStatus"] }, 3*time.Second).Should(Equal("completed"))
		Expect(request("PUT", "/api/chats", map[string]any{"chats": []any{chat}}, "test-secret").Code).To(Equal(200))
		history := getChat()["history"].([]any)
		Expect(history).To(HaveLen(3))
		Expect(history[2].(map[string]any)["content"]).To(Equal("Saved final answer"))
	})
})
