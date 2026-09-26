package routes

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/labstack/echo/v4"
	"github.com/mudler/LocalAI/core/config"
)

// Shared chats belong to this LocalAI instance, rather than to one browser.
// This intentionally makes the same conversation list available on every
// device that can open the instance's UI.
var sharedChatsMu sync.Mutex

func registerSharedChatRoutes(app *echo.Echo, appConfig *config.ApplicationConfig) {
	path := filepath.Join(appConfig.DataPath, "ui", "shared-chats.json")
	mapsPath := filepath.Join(appConfig.DataPath, "maps")

	// MAPS is intentionally read-only: the dashboard presents the source
	// signposts but never becomes another place where facts can be stored.
	app.GET("/api/maps", func(c echo.Context) error {
		entries, err := os.ReadDir(mapsPath)
		if os.IsNotExist(err) { return c.JSON(http.StatusOK, map[string]any{"maps": []any{}}) }
		if err != nil { return c.JSON(http.StatusInternalServerError, map[string]string{"error": "unable to read maps"}) }
		maps := make([]map[string]string, 0)
		for _, entry := range entries {
			if entry.IsDir() || filepath.Ext(entry.Name()) != ".md" { continue }
			data, readErr := os.ReadFile(filepath.Join(mapsPath, entry.Name()))
			if readErr != nil { continue }
			maps = append(maps, map[string]string{"name": entry.Name(), "content": string(data)})
		}
		return c.JSON(http.StatusOK, map[string]any{"maps": maps})
	})

	app.GET("/api/chats", func(c echo.Context) error {
		sharedChatsMu.Lock()
		defer sharedChatsMu.Unlock()
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			return c.JSON(http.StatusOK, map[string]any{"chats": []any{}})
		}
		if err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "unable to read shared chats"})
		}
		return c.Blob(http.StatusOK, echo.MIMEApplicationJSONCharsetUTF8, data)
	})

	app.PUT("/api/chats", func(c echo.Context) error {
		var payload json.RawMessage
		if err := json.NewDecoder(http.MaxBytesReader(c.Response(), c.Request().Body, 20<<20)).Decode(&payload); err != nil || !json.Valid(payload) {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid shared chat data"})
		}
		var shape struct{ Chats json.RawMessage `json:"chats"` }
		if json.Unmarshal(payload, &shape) != nil || !json.Valid(shape.Chats) {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "shared chat data must include chats"})
		}
		sharedChatsMu.Lock()
		defer sharedChatsMu.Unlock()
		if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "unable to create chat storage"})
		}
		temp := path + ".tmp"
		if err := os.WriteFile(temp, payload, 0o600); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "unable to save shared chats"})
		}
		if err := os.Rename(temp, path); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "unable to publish shared chats"})
		}
		return c.NoContent(http.StatusNoContent)
	})
}
