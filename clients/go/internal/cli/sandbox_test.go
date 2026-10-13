package cli

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestSandboxCommandsMapToProtocolCommands(t *testing.T) {
	cases := []struct {
		name     string
		args     []string
		method   string
		params   map[string]any
		mutating bool
	}{
		{name: "status", args: []string{"sandbox", "status"}, method: "sandbox.status", params: map[string]any{}},
		{
			name: "exec", args: []string{"sandbox", "exec", "go test ./..."},
			method: "sandbox.exec", mutating: true, params: map[string]any{"command": "go test ./..."},
		},
		{
			name: "exec with cwd and timeout", args: []string{"sandbox", "exec", "make", "--cwd", "svc/api", "--timeout-s", "90"},
			method: "sandbox.exec", mutating: true,
			params: map[string]any{"command": "make", "cwd": "svc/api", "timeout_s": float64(90)},
		},
		{
			name: "exec-cancel", args: []string{"sandbox", "exec-cancel", "exec_123"},
			method: "sandbox.exec.cancel", mutating: true, params: map[string]any{"exec_id": "exec_123"},
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			code, envelope, stdout, stderr := roomCall(t, "", test.args...)
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

func TestSandboxRejectsBadUsageBeforeAnyRequest(t *testing.T) {
	cases := map[string][]string{
		"no subcommand":           {"sandbox"},
		"unknown subcommand":      {"sandbox", "destroy"},
		"status with an argument": {"sandbox", "status", "now"},
		"exec without command":    {"sandbox", "exec"},
		"exec with empty command": {"sandbox", "exec", ""},
		"exec with two commands":  {"sandbox", "exec", "ls", "-la"},
		"exec command too long":   {"sandbox", "exec", strings.Repeat("x", maxCommandBytes+1)},
		"exec cwd too long":       {"sandbox", "exec", "ls", "--cwd", strings.Repeat("x", maxCwdBytes+1)},
		"exec negative timeout":   {"sandbox", "exec", "ls", "--timeout-s", "-1"},
		"exec timeout too long":   {"sandbox", "exec", "ls", "--timeout-s", "3601"},
		"exec-cancel without id":  {"sandbox", "exec-cancel"},
		"exec-cancel wrong id":    {"sandbox", "exec-cancel", "task_1"},
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
			if code != 64 || requests != 0 {
				t.Fatalf("exit = %d (want 64), %d requests; stderr = %s", code, requests, stderr.String())
			}
		})
	}
}
