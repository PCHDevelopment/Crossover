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
	"testing"
)

// roomCall runs the CLI against a one-command server that records the envelope it receives.
func roomCall(t *testing.T, stdin string, args ...string) (code int, envelope map[string]any, stdout, stderr string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	config := filepath.Join(t.TempDir(), "room.json")
	if err := saveConfig(config, &Config{Server: server.URL, Rooms: map[string]RoomTokens{
		roomKey(server.URL, "room_demo"): {AccessToken: "access", RefreshToken: "refresh"},
	}}); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code = Run(context.Background(), append([]string{"--server", server.URL, "--room", "room_demo"}, args...),
		strings.NewReader(stdin), &out, &errOut, config)
	return code, envelope, out.String(), errOut.String()
}

func TestMessagesAndInboxMapToCommands(t *testing.T) {
	dir := t.TempDir()
	bodyFile := filepath.Join(dir, "body.txt")
	if err := os.WriteFile(bodyFile, []byte("from a file\nsecond line"), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name     string
		args     []string
		stdin    string
		method   string
		params   map[string]any
		mutating bool
	}{
		{
			name: "send with mentions, refs and a reply",
			args: []string{"messages", "send", "Please look", "--mention", "part_a", "--mention", "part_b",
				"--ref", "task:task_1", "--ref", "file:src/a,b.ts", "--reply-to", "msg_1"},
			method: "messages.send", mutating: true,
			params: map[string]any{
				"body": "Please look", "mentions": []any{"part_a", "part_b"}, "reply_to": "msg_1",
				"refs": []any{
					map[string]any{"kind": "task", "id": "task_1"},
					map[string]any{"kind": "file", "id": "src/a,b.ts"}, // a comma is part of the path
				},
			},
		},
		{
			name: "send from a file", args: []string{"messages", "send", "--body-file", bodyFile},
			method: "messages.send", mutating: true,
			params: map[string]any{"body": "from a file\nsecond line"},
		},
		{
			name: "send from stdin", args: []string{"messages", "send", "--body-file", "-"}, stdin: "piped text\n",
			method: "messages.send", mutating: true,
			params: map[string]any{"body": "piped text\n"},
		},
		{
			name: "list the latest", args: []string{"messages", "list"},
			method: "messages.list", params: map[string]any{"limit": float64(50)},
		},
		{
			name: "list before a message", args: []string{"messages", "list", "--before", "msg_9", "--limit", "5"},
			method: "messages.list", params: map[string]any{"limit": float64(5), "before": "msg_9"},
		},
		{
			name: "list after a message", args: []string{"messages", "list", "--after", "msg_9"},
			method: "messages.list", params: map[string]any{"limit": float64(50), "after": "msg_9"},
		},
		{
			name: "edit", args: []string{"messages", "edit", "msg_1", "fixed text"},
			method: "messages.edit", mutating: true,
			params: map[string]any{"message_id": "msg_1", "body": "fixed text"},
		},
		{
			name: "edit from stdin", args: []string{"messages", "edit", "msg_1", "--body-file", "-"}, stdin: "from stdin",
			method: "messages.edit", mutating: true,
			params: map[string]any{"message_id": "msg_1", "body": "from stdin"},
		},
		{
			name: "inbox list defaults to what still needs me", args: []string{"inbox", "list"},
			method: "inbox.list", params: map[string]any{"unacked_only": true, "limit": float64(50)},
		},
		{
			name: "inbox list --all", args: []string{"inbox", "list", "--all", "--after", "inb_3", "--limit", "10"},
			method: "inbox.list", params: map[string]any{"unacked_only": false, "limit": float64(10), "after": "inb_3"},
		},
		{
			name: "inbox ack", args: []string{"inbox", "ack", "inb_1", "inb_2"},
			method: "inbox.ack", mutating: true, params: map[string]any{"ids": []any{"inb_1", "inb_2"}},
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			code, envelope, stdout, stderr := roomCall(t, test.stdin, test.args...)
			if code != 0 {
				t.Fatalf("exit = %d, stderr = %s", code, stderr)
			}
			if envelope["method"] != test.method || !reflect.DeepEqual(envelope["params"], test.params) {
				t.Fatalf("envelope = %#v, want %s %#v", envelope, test.method, test.params)
			}
			key, hasKey := envelope["idempotency_key"].(string)
			if hasKey != test.mutating || (test.mutating && key == "") {
				t.Fatalf("idempotency key = %q, present = %t; mutating = %t", key, hasKey, test.mutating)
			}
			if !strings.Contains(stdout, `"ok": true`) {
				t.Fatalf("stdout = %q", stdout)
			}
		})
	}
}

func TestMessagesAndInboxRejectBadUsageBeforeAnyRequest(t *testing.T) {
	long := strings.Repeat("x", maxMessageBytes+1)
	many := func(flag string, n int) []string {
		args := []string{"messages", "send", "hi"}
		for i := 0; i < n; i++ {
			value := "part_x"
			if flag == "--ref" {
				value = "task:t"
			}
			args = append(args, flag, value)
		}
		return args
	}
	cases := map[string][]string{
		"no subcommand":               {"messages"},
		"unknown subcommand":          {"messages", "delete"},
		"send without text":           {"messages", "send"},
		"send with blank text":        {"messages", "send", "   "},
		"send with two texts":         {"messages", "send", "a", "b"},
		"send with text and file":     {"messages", "send", "a", "--body-file", "-"},
		"send too long":               {"messages", "send", long},
		"send bad ref":                {"messages", "send", "hi", "--ref", "task"},
		"send ref without id":         {"messages", "send", "hi", "--ref", "task:"},
		"send empty mention":          {"messages", "send", "hi", "--mention", ""},
		"send 51 mentions":            many("--mention", 51),
		"send 21 refs":                many("--ref", 21),
		"list before and after":       {"messages", "list", "--before", "a", "--after", "b"},
		"list limit 0":                {"messages", "list", "--limit", "0"},
		"list limit 101":              {"messages", "list", "--limit", "101"},
		"list with an argument":       {"messages", "list", "msg_1"},
		"edit without id":             {"messages", "edit"},
		"edit without text":           {"messages", "edit", "msg_1"},
		"inbox without subcommand":    {"inbox"},
		"inbox list limit 101":        {"inbox", "list", "--limit", "101"},
		"inbox ack without ids":       {"inbox", "ack"},
		"inbox ack 101 ids":           append([]string{"inbox", "ack"}, make([]string, 101)...),
		"inbox unknown subcommand":    {"inbox", "delete"},
		"inbox list with an argument": {"inbox", "list", "inb_1"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests++ }))
			defer server.Close()
			config := filepath.Join(t.TempDir(), "room.json")
			if err := saveConfig(config, &Config{Server: server.URL, Rooms: map[string]RoomTokens{
				roomKey(server.URL, "room_demo"): {AccessToken: "access"},
			}}); err != nil {
				t.Fatal(err)
			}
			var stdout, stderr bytes.Buffer
			code := Run(context.Background(), append([]string{"--server", server.URL, "--room", "room_demo"}, args...),
				strings.NewReader(""), &stdout, &stderr, config)
			if code != 64 {
				t.Fatalf("exit = %d, want 64; stderr = %s", code, stderr.String())
			}
			if requests != 0 {
				t.Fatalf("%d requests were made for a usage error", requests)
			}
		})
	}
}

func TestMessagesAPIErrorKeepsBodyAndExitCode(t *testing.T) {
	body := `{"error":{"code":"VALIDATION","message":"Referenced task task_x isn't in this room","retryable":false,"details":{"unknown_refs":[{"kind":"task","id":"task_x"}]}}}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(body))
	}))
	defer server.Close()
	config := filepath.Join(t.TempDir(), "room.json")
	if err := saveConfig(config, &Config{Server: server.URL, Rooms: map[string]RoomTokens{
		roomKey(server.URL, "room_demo"): {AccessToken: "access"},
	}}); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"--server", server.URL, "--room", "room_demo", "messages", "send", "hi", "--ref", "task:task_x"},
		strings.NewReader(""), &stdout, &stderr, config)
	if code != 13 { // VALIDATION
		t.Fatalf("exit = %d, stderr = %s", code, stderr.String())
	}
	if strings.TrimSpace(stderr.String()) != body || stdout.Len() != 0 {
		t.Fatalf("stdout = %q, stderr = %q", stdout.String(), stderr.String())
	}
}
