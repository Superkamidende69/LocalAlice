// Package uichat owns UI generations independently of browser connections.
package uichat

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Job struct {
	ID        string         `json:"id"`
	Owner     string         `json:"owner"`
	Chat      map[string]any `json:"chat"`
	Status    string         `json:"status"`
	Content   string         `json:"content"`
	Reasoning string         `json:"reasoning"`
	Notice    string         `json:"notice,omitempty"`
	Usage     map[string]any `json:"usage,omitempty"`
	Activity  []any          `json:"activity,omitempty"`
	UpdatedAt int64          `json:"updatedAt"`
	Raw       string         `json:"-"`
}

type Store struct {
	mu      sync.Mutex
	dir     string
	jobs    map[string]*Job
	cancels map[string]context.CancelFunc
	handler http.Handler
}

func New(dir string, handler http.Handler) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, jobs: map[string]*Job{}, cancels: map[string]context.CancelFunc{}, handler: handler}
	paths, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var job Job
		if err = json.Unmarshal(data, &job); err != nil {
			return nil, err
		}
		if job.Status == "running" {
			job.Status = "interrupted"
			job.Notice = "LocalAI restarted. The saved partial response is available; retry to generate a new answer."
			if err = s.save(&job); err != nil {
				return nil, err
			}
		}
		s.jobs[job.ID] = &job
	}
	return s, nil
}

func validID(id string) bool {
	if len(id) < 8 || len(id) > 100 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

func (s *Store) save(job *Job) error {
	job.UpdatedAt = time.Now().UnixMilli()
	data, err := json.Marshal(job)
	if err != nil {
		return err
	}
	path := filepath.Join(s.dir, job.ID+".json")
	if err = os.WriteFile(path+".tmp", data, 0600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

// Start commits the request before launching inference. A repeated ID never
// starts a second generation, even after the browser loses the POST response.
func (s *Store) Start(id, owner string, chat map[string]any, endpoint string, body json.RawMessage, headers http.Header) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !validID(id) {
		return errors.New("invalid request ID")
	}
	if old := s.jobs[id]; old != nil {
		if old.Owner != owner || old.Chat["id"] != chat["id"] {
			return errors.New("request ID already used")
		}
		return nil
	}
	for _, old := range s.jobs {
		if old.Status == "running" && old.Chat["id"] == chat["id"] {
			return errors.New("this chat already has a running response")
		}
	}
	if endpoint != "/v1/chat/completions" && endpoint != "/v1/mcp/chat/completions" {
		return errors.New("unsupported chat endpoint")
	}
	var request map[string]any
	if json.Unmarshal(body, &request) != nil || request["model"] == nil {
		return errors.New("invalid chat request")
	}
	request["stream"] = true
	// Bound total output, including reasoning. This is separate from the model's
	// configured context window and prevents an unbounded background request.
	if n, ok := request["max_tokens"].(float64); !ok || n <= 0 || n > 4096 {
		request["max_tokens"] = 4096
	}
	if model, _ := request["model"].(string); strings.Contains(strings.ToLower(model), "gpt-oss") && request["reasoning_effort"] == nil {
		request["reasoning_effort"] = "low"
	}
	body, _ = json.Marshal(request)
	job := &Job{ID: id, Owner: owner, Chat: chat, Status: "running"}
	if err := s.save(job); err != nil {
		return err
	}
	s.jobs[id] = job
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	s.cancels[id] = cancel
	go s.run(ctx, job, endpoint, body, headers.Clone())
	return nil
}

func (s *Store) Cancel(id, owner string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	job := s.jobs[id]
	if job == nil || job.Owner != owner {
		return false
	}
	if cancel := s.cancels[id]; cancel != nil {
		cancel()
	}
	return true
}

// Overlay uses the server checkpoint as the single source for generated turns.
// Settings remain editable, and clearing/forking a chat clears its generation ID.
func (s *Store) Overlay(chat map[string]any) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, _ := chat["generationId"].(string)
	job := s.jobs[id]
	if job == nil || job.Chat["id"] != chat["id"] {
		return
	}
	history, _ := job.Chat["history"].([]any)
	history = append([]any{}, history...)
	if job.Reasoning != "" {
		history = append(history, map[string]any{"role": "thinking", "content": job.Reasoning, "expanded": false, "generationId": id})
	}
	history = append(history, job.Activity...)
	if job.Content != "" {
		history = append(history, map[string]any{"role": "assistant", "content": job.Content, "generationId": id})
	}
	chat["history"] = history
	chat["generationStatus"] = job.Status
	chat["generationNotice"] = job.Notice
	if job.Usage != nil {
		chat["tokenUsage"] = map[string]any{"prompt": job.Usage["prompt_tokens"], "completion": job.Usage["completion_tokens"], "total": job.Usage["total_tokens"]}
	}
	if updated, _ := chat["updatedAt"].(float64); float64(job.UpdatedAt) > updated {
		chat["updatedAt"] = job.UpdatedAt
	}
}

type streamWriter struct {
	writer *io.PipeWriter
	header http.Header
	status int
}

func (w *streamWriter) Header() http.Header { return w.header }
func (w *streamWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *streamWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	return w.writer.Write(data)
}
func (w *streamWriter) Flush() {}

func (s *Store) run(ctx context.Context, job *Job, endpoint string, body []byte, headers http.Header) {
	status, notice := "completed", ""
	defer func() {
		if recovered := recover(); recovered != nil {
			status, notice = "failed", "Generation failed unexpectedly; saved text is retained."
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if cancel := s.cancels[job.ID]; cancel != nil {
			cancel()
			delete(s.cancels, job.ID)
		}
		job.Status, job.Notice = status, notice
		if err := s.save(job); err != nil {
			job.Notice = "Could not save final response: " + err.Error()
		}
	}()
	for {
		if ctx.Err() != nil {
			status, notice = "stopped", "Generation stopped. Saved text is retained."
			return
		}
		r, w := io.Pipe()
		writer := &streamWriter{writer: w, header: make(http.Header)}
		req, _ := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(body))
		req.Header = headers.Clone()
		req.Header.Del("Accept-Encoding")
		req.Header.Del("Content-Length")
		req.Header.Set("Content-Type", "application/json")
		done := make(chan struct{})
		go func() {
			defer close(done)
			defer w.Close()
			defer func() {
				if p := recover(); p != nil {
					_ = w.CloseWithError(fmt.Errorf("inference handler failed"))
				}
			}()
			s.handler.ServeHTTP(writer, req)
		}()
		stop := context.AfterFunc(ctx, func() { _ = r.CloseWithError(ctx.Err()) })
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 4096), 4<<20)
		var nonStream strings.Builder
		lastSave := time.Now()
		finished := false
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "data: [DONE]" {
				finished = true
				continue
			}
			if !strings.HasPrefix(line, "data:") {
				if nonStream.Len() < 65536 {
					nonStream.WriteString(line)
				}
				continue
			}
			var event map[string]any
			if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(line, "data:"))), &event) != nil {
				continue
			}
			s.mu.Lock()
			consume(job, event)
			if time.Since(lastSave) >= 500*time.Millisecond {
				if repetitive(job.Reasoning) {
					status, notice = "stopped", "Stopped a repeated thinking loop. Saved text is retained; retry with a shorter request or different model."
				}
				if len(job.Reasoning) > 24000 {
					status, notice = "stopped", "Stopped after the thinking budget was reached. Saved text is retained."
				}
				if len(job.Raw)+len(job.Reasoning) > 4<<20 {
					status, notice = "stopped", "Response size limit reached."
				}
				if err := s.save(job); err != nil {
					status, notice = "failed", "Could not save response: "+err.Error()
				}
				lastSave = time.Now()
			}
			if event["error"] != nil {
				status, notice = "failed", fmt.Sprint(event["error"])
			}
			if event["type"] == "error" {
				status, notice = "failed", fmt.Sprint(event["message"])
			}
			if choices, ok := event["choices"].([]any); ok && len(choices) > 0 {
				choice, _ := choices[0].(map[string]any)
				if reason, _ := choice["finish_reason"].(string); reason != "" {
					finished = true
					if reason == "length" {
						notice = "Output limit reached. Ask to continue if you need more."
					}
				}
			}
			s.mu.Unlock()
			if status != "completed" {
				s.Cancel(job.ID, job.Owner)
				break
			}
		}
		scanErr := scanner.Err()
		_ = r.Close()
		stop()
		<-done
		if status != "completed" {
			return
		}
		if ctx.Err() != nil {
			status, notice = "stopped", "Generation stopped. Saved text is retained."
			return
		}
		if writer.status == http.StatusServiceUnavailable && strings.Contains(nonStream.String(), "model_loading") {
			select {
			case <-ctx.Done():
				continue
			case <-time.After(3 * time.Second):
				continue
			}
		}
		if writer.status >= 400 {
			status, notice = "failed", fmt.Sprintf("HTTP %d: %s", writer.status, nonStream.String())
			return
		}
		if scanErr != nil {
			status, notice = "interrupted", "Stream interrupted: "+scanErr.Error()
			return
		}
		if !finished {
			status, notice = "interrupted", "The model stream ended unexpectedly. Saved text is retained."
		}
		return
	}
}

func consume(job *Job, event map[string]any) {
	if kind, _ := event["type"].(string); kind == "tool_call" || kind == "tool_result" || kind == "mcp_tool_result" {
		role := kind
		if role == "mcp_tool_result" {
			role = "tool_result"
		}
		data, _ := json.Marshal(event)
		job.Activity = append(job.Activity, map[string]any{"role": role, "content": string(data), "expanded": false})
	}
	if usage, ok := event["usage"].(map[string]any); ok {
		job.Usage = usage
	}
	if choices, ok := event["choices"].([]any); ok && len(choices) > 0 {
		choice, _ := choices[0].(map[string]any)
		delta, _ := choice["delta"].(map[string]any)
		if content, ok := delta["content"].(string); ok {
			job.Raw += content
		}
		if reason, ok := delta["reasoning"].(string); ok {
			job.Reasoning += reason
		} else if reason, ok := delta["reasoning_content"].(string); ok {
			job.Reasoning += reason
		}
	}
	if text, ok := event["content"].(string); ok {
		switch event["type"] {
		case "assistant":
			job.Raw += text
		case "reasoning":
			job.Reasoning += text
		}
	}
	content, thinking := SplitThinking(job.Raw)
	job.Content = content
	if thinking != "" {
		job.Reasoning = thinking
	}
}

// SplitThinking keeps even an unclosed thinking block out of assistant text.
func SplitThinking(raw string) (string, string) {
	var content, thinking strings.Builder
	for len(raw) > 0 {
		start, opening, closing := -1, "", ""
		for _, tags := range [][2]string{{"<think>", "</think>"}, {"<thinking>", "</thinking>"}, {"<|channel>thought", "<channel|>"}} {
			if i := strings.Index(raw, tags[0]); i >= 0 && (start < 0 || i < start) {
				start, opening, closing = i, tags[0], tags[1]
			}
		}
		if start < 0 {
			content.WriteString(raw)
			break
		}
		content.WriteString(raw[:start])
		raw = raw[start+len(opening):]
		end := strings.Index(raw, closing)
		if end < 0 {
			thinking.WriteString(raw)
			break
		}
		thinking.WriteString(raw[:end])
		raw = raw[end+len(closing):]
	}
	return content.String(), thinking.String()
}

func repetitive(text string) bool {
	words := strings.Fields(strings.ToLower(text))
	if len(words) > 1000 {
		words = words[len(words)-1000:]
	}
	for size := 8; size <= 160 && size*4 <= len(words); size++ {
		end := len(words)
		block := strings.Join(words[end-size:], " ")
		if len(block) < 40 {
			continue
		}
		match := true
		for repeat := 2; repeat <= 4; repeat++ {
			if strings.Join(words[end-repeat*size:end-(repeat-1)*size], " ") != block {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
