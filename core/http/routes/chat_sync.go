package routes

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/labstack/echo/v4"
	"github.com/mudler/LocalAI/core/config"
	"github.com/mudler/LocalAI/core/http/auth"
	"github.com/mudler/LocalAI/core/services/uichat"
	"github.com/mudler/xlog"
)

// Shared chats belong to this LocalAI instance, rather than to one browser.
// This intentionally makes the same conversation list available on every
// device that can open the instance's UI.
var sharedChatsMu sync.Mutex

func registerSharedChatRoutes(app *echo.Echo, appConfig *config.ApplicationConfig) {
	path := filepath.Join(appConfig.DataPath, "ui", "shared-chats.json")
	mapsPath := filepath.Join(appConfig.DataPath, "maps")
	jobs, jobsErr := uichat.New(filepath.Join(appConfig.DataPath, "ui", "generations"), app)
	if jobsErr != nil {
		xlog.Error("Unable to open chat generation storage", "error", jobsErr)
	}
	read := func() (map[string]any, error) {
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			return map[string]any{"chats": []any{}}, nil
		}
		if err != nil {
			return nil, err
		}
		var result map[string]any
		if err := json.Unmarshal(data, &result); err != nil {
			return nil, err
		}
		if jobs != nil {
			chats, _ := result["chats"].([]any)
			for _, item := range chats {
				if chat, ok := item.(map[string]any); ok {
					jobs.Overlay(chat)
				}
			}
		}
		return result, nil
	}
	write := func(payload any) error {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		if err = os.MkdirAll(filepath.Dir(path), 0750); err != nil {
			return err
		}
		if err = os.WriteFile(path+".tmp", data, 0600); err != nil {
			return err
		}
		return os.Rename(path+".tmp", path)
	}

	// Generation runs through the existing inference handler and authentication
	// middleware. Credentials are copied only in memory, never saved to disk.
	app.POST("/api/chats/generate", startSavedChat(jobs, read, write))
	app.POST("/api/chats/generations/:id/cancel", cancelSavedChat(jobs))
	// MAPS is intentionally read-only: the dashboard presents the source
	// signposts but never becomes another place where facts can be stored.
	app.GET("/api/maps", func(c echo.Context) error {
		entries, err := os.ReadDir(mapsPath)
		if os.IsNotExist(err) {
			return c.JSON(http.StatusOK, map[string]any{"maps": []any{}})
		}
		if err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "unable to read maps"})
		}
		maps := make([]map[string]string, 0)
		for _, entry := range entries {
			if entry.IsDir() || filepath.Ext(entry.Name()) != ".md" {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(mapsPath, entry.Name()))
			if readErr != nil {
				continue
			}
			maps = append(maps, map[string]string{"name": entry.Name(), "content": string(data)})
		}
		return c.JSON(http.StatusOK, map[string]any{"maps": maps})
	})

	app.GET("/api/chats", func(c echo.Context) error {
		sharedChatsMu.Lock()
		defer sharedChatsMu.Unlock()
		data, err := read()
		if err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "unable to read shared chats"})
		}
		c.Response().Header().Set("Cache-Control", "no-store")
		return c.JSON(http.StatusOK, data)
	})

	app.PUT("/api/chats", func(c echo.Context) error {
		var payload json.RawMessage
		if err := json.NewDecoder(http.MaxBytesReader(c.Response(), c.Request().Body, 20<<20)).Decode(&payload); err != nil || !json.Valid(payload) {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid shared chat data"})
		}
		var shape struct {
			Chats json.RawMessage `json:"chats"`
		}
		if json.Unmarshal(payload, &shape) != nil || !json.Valid(shape.Chats) {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "shared chat data must include chats"})
		}
		sharedChatsMu.Lock()
		defer sharedChatsMu.Unlock()
		var incoming map[string]any
		_ = json.Unmarshal(payload, &incoming)
		current, err := read()
		if err != nil {
			return echo.NewHTTPError(500, "Unable to read chats")
		}
		oldChats, _ := current["chats"].([]any)
		newChats, ok := incoming["chats"].([]any)
		if !ok {
			return echo.NewHTTPError(400, "chats must be an array")
		}
		// A delayed browser save must not replace a running job's history.
		for _, item := range oldChats {
			old, ok := item.(map[string]any)
			if !ok {
				continue
			}
			found := false
			for i, next := range newChats {
				chat, ok := next.(map[string]any)
				if !ok {
					continue
				}
				if old["id"] != chat["id"] {
					continue
				}
				found = true
				oldTime, _ := json.Marshal(old["updatedAt"])
				newTime, _ := json.Marshal(chat["updatedAt"])
				var oldMS, newMS float64
				_ = json.Unmarshal(oldTime, &oldMS)
				_ = json.Unmarshal(newTime, &newMS)
				if old["generationStatus"] == "running" || oldMS > newMS {
					newChats[i] = old
				} else if jobs != nil {
					jobs.Overlay(chat)
				}
				break
			}
			if !found && old["generationStatus"] == "running" {
				newChats = append(newChats, old)
			}
		}
		incoming["chats"], incoming["lastSaved"] = newChats, time.Now().UnixMilli()
		if err := write(incoming); err != nil {
			return echo.NewHTTPError(500, "Unable to save chats")
		}
		return c.JSON(http.StatusOK, incoming)
	})
}

// startSavedChat starts a saved UI generation.
// @Summary Start a saved UI chat generation
// @Tags inference
// @Accept json
// @Produce json
// @Param request body object true "Request ID, chat snapshot, endpoint and chat completion request"
// @Success 202 {object} map[string]string
// @Router /api/chats/generate [post]
func startSavedChat(jobs *uichat.Store, read func() (map[string]any, error), write func(any) error) echo.HandlerFunc {
	return func(c echo.Context) error {
		if jobs == nil {
			return echo.NewHTTPError(503, "Chat generation storage unavailable")
		}
		var input struct {
			ID       string          `json:"id"`
			Chat     map[string]any  `json:"chat"`
			Endpoint string          `json:"endpoint"`
			Request  json.RawMessage `json:"request"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(c.Response(), c.Request().Body, 20<<20)).Decode(&input); err != nil || input.Chat == nil || input.Chat["id"] == nil {
			return echo.NewHTTPError(400, "Invalid chat request")
		}
		owner := ""
		if user := auth.GetUser(c); user != nil {
			owner = user.ID
		}
		sharedChatsMu.Lock()
		defer sharedChatsMu.Unlock()
		data, err := read()
		if err != nil {
			return echo.NewHTTPError(500, "Unable to read chats")
		}
		input.Chat["generationId"] = input.ID
		input.Chat["generationStatus"] = "running"
		input.Chat["updatedAt"] = time.Now().UnixMilli()
		if err = jobs.Start(input.ID, owner, input.Chat, input.Endpoint, input.Request, c.Request().Header); err != nil {
			return echo.NewHTTPError(409, err.Error())
		}
		chats, _ := data["chats"].([]any)
		found := false
		for i, item := range chats {
			if chat, ok := item.(map[string]any); ok && chat["id"] == input.Chat["id"] {
				chats[i] = input.Chat
				found = true
				break
			}
		}
		if !found {
			chats = append(chats, input.Chat)
		}
		data["chats"], data["lastSaved"] = chats, time.Now().UnixMilli()
		if err = write(data); err != nil {
			jobs.Cancel(input.ID, owner)
			return echo.NewHTTPError(500, "Unable to save chat")
		}
		return c.JSON(http.StatusAccepted, map[string]any{"id": input.ID})
	}
}

// cancelSavedChat cancels an owned UI generation.
// @Summary Stop a saved UI chat generation
// @Tags inference
// @Param id path string true "Generation ID"
// @Success 202
// @Router /api/chats/generations/{id}/cancel [post]
func cancelSavedChat(jobs *uichat.Store) echo.HandlerFunc {
	return func(c echo.Context) error {
		owner := ""
		if user := auth.GetUser(c); user != nil {
			owner = user.ID
		}
		if jobs == nil || !jobs.Cancel(c.Param("id"), owner) {
			return echo.NewHTTPError(404, "Generation not found")
		}
		return c.NoContent(http.StatusAccepted)
	}
}
