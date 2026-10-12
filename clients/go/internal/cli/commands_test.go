package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestCommandGoldenOutputsAndEnvelopes(t *testing.T) {
	dir := t.TempDir()
	evidencePath := filepath.Join(dir, "evidence.json")
	if err := os.WriteFile(evidencePath, []byte(`[{"kind":"test","url":"https://example.test"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	paramsPath := filepath.Join(dir, "changeset.json")
	if err := os.WriteFile(paramsPath, []byte(`{"source":"agent","message":"apply","base_revision":"rev_1","operations":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name        string
		args        []string
		method      string
		params      map[string]any
		mutating    bool
		explicitKey string
	}{
		{
			name:   "tasks list",
			args:   []string{"tasks", "list", "--status", "OPEN", "--status", "BLOCKED", "--mine", "--owner", "part_1", "--cursor", "cur_1", "--limit", "6"},
			method: "tasks.list",
			params: map[string]any{"status": []any{"OPEN", "BLOCKED"}, "mine": true, "owner_id": "part_1", "cursor": "cur_1", "limit": float64(6)},
		},
		{
			name: "tasks get",
			args: []string{"tasks", "get", "task_123"}, method: "tasks.get",
			params: map[string]any{"task_id": "task_123"},
		},
		{
			name: "tasks claim",
			args: []string{"tasks", "claim", "task_123", "--version", "4"}, method: "tasks.claim",
			params: map[string]any{"task_id": "task_123", "expected_version": float64(4)}, mutating: true,
		},
		{
			name: "tasks start",
			args: []string{"tasks", "start", "task_123", "--version", "5"}, method: "tasks.start",
			params: map[string]any{"task_id": "task_123", "expected_version": float64(5)}, mutating: true,
		},
		{
			name: "tasks submit",
			args: []string{"tasks", "submit", "task_123", "--version", "6", "--evidence", evidencePath}, method: "tasks.submit",
			params: map[string]any{"task_id": "task_123", "expected_version": float64(6), "evidence": []any{map[string]any{"kind": "test", "url": "https://example.test"}}}, mutating: true,
		},
		{
			name: "workspace read",
			args: []string{"workspace", "read", "README.md"}, method: "workspace.read",
			params: map[string]any{"path": "README.md"},
		},
		{
			name: "workspace apply",
			args: []string{"workspace", "apply", paramsPath, "--idempotency-key", "retry-key-123"}, method: "workspace.apply_changeset",
			params: map[string]any{"source": "agent", "message": "apply", "base_revision": "rev_1", "operations": []any{}}, mutating: true, explicitKey: "retry-key-123",
		},
	}

	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			var gotEnvelope map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v1/rooms/room_demo/commands" {
					t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
				}
				if r.Header.Get("Authorization") != "Bearer access" {
					t.Errorf("authorization = %q", r.Header.Get("Authorization"))
				}
				if err := json.NewDecoder(r.Body).Decode(&gotEnvelope); err != nil {
					t.Fatal(err)
				}
				writeHTTPFixture(t, w, "command-success.json")
			}))
			defer server.Close()
			config := filepath.Join(t.TempDir(), "room.json")
			if err := saveConfig(config, &Config{Server: server.URL, Rooms: map[string]RoomTokens{
				roomKey(server.URL, "room_demo"): {AccessToken: "access", RefreshToken: "refresh"},
			}}); err != nil {
				t.Fatal(err)
			}
			args := append([]string{"--server", server.URL, "--room", "room_demo"}, test.args...)
			var stdout, stderr bytes.Buffer
			code := Run(context.Background(), args, strings.NewReader(""), &stdout, &stderr, config)
			if code != 0 {
				t.Fatalf("command exit = %d, stderr = %s", code, stderr.String())
			}
			if got := strings.TrimSpace(stdout.String()); got != strings.TrimSpace(string(fixture(t, "command-success-output.json"))) {
				t.Fatalf("stdout golden mismatch:\n%s", stdout.String())
			}
			if gotEnvelope["method"] != test.method || !reflect.DeepEqual(gotEnvelope["params"], test.params) {
				t.Fatalf("command envelope = %#v, want method %q params %#v", gotEnvelope, test.method, test.params)
			}
			if id, ok := gotEnvelope["id"].(string); !ok || !strings.HasPrefix(id, "cmd_") {
				t.Fatalf("invalid command id %v", gotEnvelope["id"])
			}
			key, hasKey := gotEnvelope["idempotency_key"].(string)
			if hasKey != test.mutating || (test.mutating && key == "") {
				t.Fatalf("idempotency key = %v, present=%t; mutating=%t", key, hasKey, test.mutating)
			}
			if test.explicitKey != "" && key != test.explicitKey {
				t.Fatalf("explicit idempotency key = %q", key)
			}
		})
	}
}

func TestTaskProtocolErrorUsesStableExitCodeAndBody(t *testing.T) {
	errorBody := string(fixture(t, "error-conflict-version.json"))
	var attempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(errorBody))
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "room.json")
	if err := saveConfig(path, &Config{Server: server.URL, Rooms: map[string]RoomTokens{
		roomKey(server.URL, "room_demo"): {AccessToken: "access"},
	}}); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"--server", server.URL, "--room", "room_demo", "tasks", "claim", "task_123", "--version", "4",
	}, strings.NewReader(""), &stdout, &stderr, path)
	if code != 14 || strings.TrimSpace(stderr.String()) != strings.TrimSpace(errorBody) {
		t.Fatalf("exit=%d stderr=%s", code, stderr.String())
	}
	if attempts.Load() != 1 {
		t.Fatalf("non-retryable conflict made %d requests, want 1", attempts.Load())
	}
}

func TestEventTailReconnectsFromLastDeliveredSequence(t *testing.T) {
	var attempt atomic.Int32
	var subscribed []int64
	var mu sync.Mutex
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var hello map[string]any
		if err := conn.ReadJSON(&hello); err != nil {
			t.Errorf("read hello: %v", err)
			return
		}
		if hello["type"] != "hello" || hello["token"] != "access" {
			t.Errorf("hello = %#v", hello)
		}
		if err := conn.WriteMessage(websocket.TextMessage, fixture(t, "ws-hello-ok.json")); err != nil {
			return
		}
		var subscribe struct {
			Type  string `json:"type"`
			After int64  `json:"after"`
		}
		if err := conn.ReadJSON(&subscribe); err != nil {
			t.Errorf("read subscribe: %v", err)
			return
		}
		mu.Lock()
		subscribed = append(subscribed, subscribe.After)
		mu.Unlock()
		n := attempt.Add(1)
		if err := conn.WriteJSON(map[string]string{"type": "ping", "id": "ping-1"}); err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		var pong struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if err := conn.ReadJSON(&pong); err != nil {
			t.Errorf("read pong: %v", err)
			return
		}
		if pong.Type != "pong" || pong.ID != "ping-1" {
			t.Errorf("pong = %#v", pong)
			return
		}
		_ = conn.SetReadDeadline(time.Time{})
		if n == 1 {
			_ = writeFixtureFrame(t, conn, "ws-subscribed.json", map[string]any{"after": subscribe.After, "last_sequence": 7})
			_ = writeFixtureFrame(t, conn, "ws-event-7.json", nil)
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1012, "restart"), time.Now().Add(time.Second))
			return
		}
		_ = writeFixtureFrame(t, conn, "ws-subscribed.json", map[string]any{"after": subscribe.After, "last_sequence": 8})
		_ = writeFixtureFrame(t, conn, "ws-event-8.json", nil)
	}))
	defer server.Close()

	path := filepath.Join(t.TempDir(), "room.json")
	if err := saveConfig(path, &Config{Server: server.URL, Rooms: map[string]RoomTokens{
		roomKey(server.URL, "room_demo"): {AccessToken: "access", RefreshToken: "refresh"},
	}}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	writer := cancelAfterWrites{cancel: cancel, stopAfter: 2}
	var stderr bytes.Buffer
	code := Run(ctx, []string{
		"events", "tail", "--after", "6", "--server", server.URL, "--room", "room_demo",
	}, strings.NewReader(""), &writer, &stderr, path)
	if code != 0 {
		t.Fatalf("tail exit = %d, stderr = %s", code, stderr.String())
	}
	mu.Lock()
	gotSubscribed := append([]int64(nil), subscribed...)
	mu.Unlock()
	if len(gotSubscribed) != 2 || gotSubscribed[0] != 6 || gotSubscribed[1] != 7 {
		t.Fatalf("subscription cursors = %v", gotSubscribed)
	}
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := cfg.Rooms[roomKey(server.URL, "room_demo")].LastSequence; got != 8 {
		t.Fatalf("saved cursor = %d, want 8", got)
	}
	if !strings.Contains(writer.String(), `"sequence":7`) || !strings.Contains(writer.String(), `"sequence":8`) {
		t.Fatalf("events output = %s", writer.String())
	}
}

type cancelAfterWrites struct {
	bytes.Buffer
	cancel    context.CancelFunc
	stopAfter int
	count     int
}

func (w *cancelAfterWrites) Write(p []byte) (int, error) {
	n, err := w.Buffer.Write(p)
	w.count++
	if w.count >= w.stopAfter {
		w.cancel()
	}
	return n, err
}

func writeFixtureFrame(t *testing.T, conn *websocket.Conn, name string, patch map[string]any) error {
	t.Helper()
	var frame map[string]any
	if err := json.Unmarshal(fixture(t, name), &frame); err != nil {
		t.Fatal(err)
	}
	for key, value := range patch {
		frame[key] = value
	}
	return conn.WriteJSON(frame)
}
