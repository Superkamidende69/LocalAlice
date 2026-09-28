package uichat

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

func TestUIChat(t *testing.T) { RegisterFailHandler(Fail); RunSpecs(t, "Saved UI chat jobs") }

var _ = Describe("saved generation", func() {
	var dir string
	BeforeEach(func() { var err error; dir, err = os.MkdirTemp("", "uichat-test-"); Expect(err).NotTo(HaveOccurred()) })
	AfterEach(func() { Expect(os.RemoveAll(dir)).To(Succeed()) })
	chat := func() map[string]any {
		return map[string]any{"id": "chat-test", "generationId": "request-test", "history": []any{map[string]any{"role": "user", "content": "hello"}}}
	}
	body := json.RawMessage(`{"model":"gpt-oss-test","messages":[{"role":"user","content":"hello"}]}`)
	It("continues without a page, survives reloading saved files and does not rerun a duplicate POST", func() {
		var calls atomic.Int32
		release := make(chan struct{})
		store, err := New(dir, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			if payload["reasoning_effort"] != "low" || payload["max_tokens"] != float64(4096) {
				w.WriteHeader(400)
				return
			}
			fmt.Fprintln(w, `data: {"choices":[{"delta":{"reasoning":"Considering briefly."}}]}`)
			<-release
			fmt.Fprintln(w, `data: {"choices":[{"delta":{"content":"Hello!"},"finish_reason":"stop"}]}`)
			fmt.Fprintln(w, "data: [DONE]")
		}))
		Expect(err).NotTo(HaveOccurred())
		Expect(store.Start("request-test", "owner", chat(), "/v1/chat/completions", body, http.Header{})).To(Succeed())
		Eventually(func() int32 { return calls.Load() }).Should(Equal(int32(1)))
		Expect(store.Start("request-test", "owner", chat(), "/v1/chat/completions", body, http.Header{})).To(Succeed())
		view := chat()
		store.Overlay(view)
		Expect(view["generationStatus"]).To(Equal("running"))
		close(release)
		Eventually(func() any { view = chat(); store.Overlay(view); return view["generationStatus"] }).Should(Equal("completed"))
		Expect(calls.Load()).To(Equal(int32(1)))
		reloaded, err := New(dir, nil)
		Expect(err).NotTo(HaveOccurred())
		view = chat()
		reloaded.Overlay(view)
		history := view["history"].([]any)
		Expect(history).To(HaveLen(3))
		Expect(history[1].(map[string]any)["role"]).To(Equal("thinking"))
		Expect(history[2].(map[string]any)["content"]).To(Equal("Hello!"))
	})
	It("restricts cancellation to the owner and preserves partial output", func() {
		store, err := New(dir, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintln(w, `data: {"choices":[{"delta":{"content":"Partial text"}}]}`)
			<-r.Context().Done()
		}))
		Expect(err).NotTo(HaveOccurred())
		Expect(store.Start("request-test", "owner", chat(), "/v1/chat/completions", body, http.Header{})).To(Succeed())
		Eventually(func() int { v := chat(); store.Overlay(v); return len(v["history"].([]any)) }).Should(Equal(2))
		Expect(store.Cancel("request-test", "someone-else")).To(BeFalse())
		Expect(store.Cancel("request-test", "owner")).To(BeTrue())
		Eventually(func() any { v := chat(); store.Overlay(v); return v["generationStatus"] }).Should(Equal("stopped"))
		v := chat()
		store.Overlay(v)
		Expect(v["history"].([]any)[1].(map[string]any)["content"]).To(Equal("Partial text"))
	})
	It("saves an explicit interruption after a server restart and excludes credentials", func() {
		store, err := New(dir, nil)
		Expect(err).NotTo(HaveOccurred())
		job := &Job{ID: "request-test", Chat: chat(), Status: "running", Content: "Checkpoint", Reasoning: "Saved thought"}
		Expect(store.save(job)).To(Succeed())
		reloaded, err := New(dir, nil)
		Expect(err).NotTo(HaveOccurred())
		view := chat()
		reloaded.Overlay(view)
		Expect(view["generationStatus"]).To(Equal("interrupted"))
		data, err := os.ReadFile(filepath.Join(dir, "request-test.json"))
		Expect(err).NotTo(HaveOccurred())
		Expect(string(data)).NotTo(ContainSubstring("Authorization"))
	})
	It("stops repeated reasoning while leaving ordinary prose alone", func() {
		loop := strings.Repeat("I should now consider the same decision carefully before answering again. ", 6)
		Expect(repetitive(loop)).To(BeTrue())
		Expect(repetitive("Here are several distinct considerations about the problem and a useful answer.")).To(BeFalse())
		store, err := New(dir, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			time.Sleep(550 * time.Millisecond)
			event, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"reasoning": loop}}}})
			fmt.Fprintf(w, "data: %s\n", event)
			<-r.Context().Done()
		}))
		Expect(err).NotTo(HaveOccurred())
		Expect(store.Start("request-test", "owner", chat(), "/v1/chat/completions", body, http.Header{})).To(Succeed())
		Eventually(func() any { v := chat(); store.Overlay(v); return v["generationStatus"] }, 3*time.Second).Should(Equal("stopped"))
		v := chat()
		store.Overlay(v)
		Expect(v["generationNotice"]).To(ContainSubstring("repeated thinking loop"))
	})
	It("keeps an unclosed thinking block separate from the answer", func() {
		content, thinking := SplitThinking("<think>still thinking")
		Expect(content).To(BeEmpty())
		Expect(thinking).To(Equal("still thinking"))
		content, thinking = SplitThinking("<think>done</think>Answer")
		Expect(content).To(Equal("Answer"))
		Expect(thinking).To(Equal("done"))
	})
	It("rejects arbitrary endpoints and filesystem paths", func() {
		store, err := New(dir, nil)
		Expect(err).NotTo(HaveOccurred())
		Expect(store.Start("../../secret", "owner", chat(), "/v1/chat/completions", body, nil)).NotTo(Succeed())
		Expect(store.Start("request-test", "owner", chat(), "http://example.org", body, nil)).NotTo(Succeed())
	})
})
