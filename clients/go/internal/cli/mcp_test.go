package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// runMCP runs `room mcp` against handler with the given stdin lines and returns the exit code,
// the stdout lines, stderr, and the saved config path.
func runMCP(t *testing.T, handler http.HandlerFunc, tokens RoomTokens, stdin string) (code int, lines []string, stderr string, config string) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	config = filepath.Join(t.TempDir(), "room.json")
	if err := saveConfig(config, &Config{Server: server.URL, Rooms: map[string]RoomTokens{
		roomKey(server.URL, "room_demo"): tokens,
	}}); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	code = Run(context.Background(), []string{"--server", server.URL, "--room", "room_demo", "mcp"},
		strings.NewReader(stdin), &out, &errOut, config)
	for _, line := range strings.Split(strings.TrimRight(out.String(), "\n"), "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	return code, lines, errOut.String(), config
}

func TestMCPForwardsJSONAndEventStreamAnswersAndSkipsNotifications(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	handler := func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization")+" "+r.Header.Get("Content-Type")+" "+string(body))
		mu.Unlock()
		if !strings.Contains(r.Header.Get("Accept"), "text/event-stream") || !strings.Contains(r.Header.Get("Accept"), "application/json") {
			t.Errorf("Accept = %q", r.Header.Get("Accept"))
		}
		var request map[string]any
		_ = json.Unmarshal(body, &request)
		switch request["method"] {
		case "tools/list":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("{\"jsonrpc\":\"2.0"))
			_, _ = w.Write([]byte("\",\"id\":1,\"result\":{\"tools\":[]}}"))
		case "tools/call":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, ": keep-alive\r\nevent: message\r\nid: 1\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\n")
			_, _ = io.WriteString(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\ndata: \"id\":2,\"result\":{\"ok\":true}}\n\n")
		default:
			w.WriteHeader(http.StatusAccepted)
		}
	}
	stdin := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n" +
		"\n" + // blank lines are ignored
		`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"x"}}`
	code, lines, stderr, _ := runMCP(t, handler, RoomTokens{AccessToken: "secret-access", RefreshToken: "secret-refresh"}, stdin)
	if code != 0 || stderr != "" {
		t.Fatalf("exit = %d, stderr = %q", code, stderr)
	}
	got := map[string]bool{}
	for _, line := range lines {
		got[line] = true
	}
	for _, want := range []string{
		`{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`,
		`{"jsonrpc":"2.0","method":"notifications/progress"}`,
		`{"jsonrpc":"2.0","id":2,"result":{"ok":true}}`,
	} {
		if !got[want] {
			t.Errorf("stdout lacks %s; got %q", want, lines)
		}
	}
	if len(lines) != 3 {
		t.Errorf("stdout = %q, want 3 lines (nothing for the notification)", lines)
	}
	if len(seen) != 3 {
		t.Fatalf("server saw %d requests: %q", len(seen), seen)
	}
	for _, request := range seen {
		if !strings.HasPrefix(request, "POST /mcp Bearer secret-access application/json {") {
			t.Errorf("request = %q", request)
		}
	}
}

func TestMCPRefreshesAnExpiredTokenOnceAndRetries(t *testing.T) {
	var mu sync.Mutex
	var refreshes int
	handler := func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/auth/refresh":
			mu.Lock()
			refreshes++
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"access_token":"access-new","refresh_token":"refresh-new"}`)
		case "/mcp":
			if r.Header.Get("Authorization") != "Bearer access-new" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = io.WriteString(w, `{"error":{"code":"UNAUTHENTICATED","message":"expired","retryable":false}}`)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{}}`)
		}
	}
	code, lines, stderr, config := runMCP(t, handler, RoomTokens{AccessToken: "access-old", RefreshToken: "refresh-old"},
		`{"jsonrpc":"2.0","id":1,"method":"ping"}`+"\n")
	if code != 0 || len(lines) != 1 || lines[0] != `{"jsonrpc":"2.0","id":1,"result":{}}` {
		t.Fatalf("exit = %d, stdout = %q, stderr = %q", code, lines, stderr)
	}
	if refreshes != 1 {
		t.Fatalf("refreshes = %d", refreshes)
	}
	cfg, err := loadConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	for _, cred := range cfg.Rooms {
		if cred.AccessToken != "access-new" || cred.RefreshToken != "refresh-new" {
			t.Fatalf("saved credentials = %#v", cred)
		}
	}
}

func TestMCPAnswersFailuresWithJSONRPCErrorsAndNeverPrintsTokens(t *testing.T) {
	handler := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":{"code":"FORBIDDEN","message":"no access for secret-access","retryable":false}}`)
	}
	stdin := `{"jsonrpc":"2.0","id":"a","method":"tools/call"}` + "\n" +
		`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n" + // no id: nothing to answer
		`not json` + "\n" +
		`[{"jsonrpc":"2.0","id":7,"method":"ping"},{"jsonrpc":"2.0","id":null,"method":"x"}]` + "\n"
	code, lines, stderr, _ := runMCP(t, handler, RoomTokens{AccessToken: "secret-access", RefreshToken: "secret-refresh"}, stdin)
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	var ids []string
	for _, line := range lines {
		var reply struct {
			ID    json.RawMessage `json:"id"`
			Error struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(line), &reply); err != nil || reply.Error.Code == 0 {
			t.Fatalf("stdout line %q is not a JSON-RPC error", line)
		}
		ids = append(ids, string(reply.ID)+":"+itoa(reply.Error.Code))
	}
	want := map[string]bool{`"a":-32603`: true, `null:-32700`: true, `7:-32603`: true}
	if len(ids) != 3 {
		t.Fatalf("errors = %q", ids)
	}
	for _, id := range ids {
		if !want[id] {
			t.Errorf("unexpected error %s in %q", id, ids)
		}
	}
	for _, text := range append(lines, stderr) {
		if strings.Contains(text, "secret-access") || strings.Contains(text, "secret-refresh") {
			t.Fatalf("a token leaked: %q", text)
		}
	}
	if !strings.Contains(stderr, "no access for [REDACTED]") {
		t.Errorf("stderr = %q", stderr)
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestMCPHandlesLargeMessagesAndRunsRequestsConcurrently(t *testing.T) {
	release := make(chan struct{})
	handler := func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var request struct {
			ID     int    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.Unmarshal(body, &request)
		if request.Method == "slow" {
			select { // answered only once the later request has been answered
			case <-release:
			case <-time.After(10 * time.Second):
				t.Error("the slow request was never released: requests are not concurrent")
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":`+itoa(request.ID)+`,"result":{"bytes":`+itoa(len(body))+`}}`)
		if request.Method == "fast" {
			close(release)
		}
	}
	big := `{"jsonrpc":"2.0","id":3,"method":"big","params":{"data":"` + strings.Repeat("x", 2*1024*1024) + `"}}`
	stdin := `{"jsonrpc":"2.0","id":1,"method":"slow"}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"fast"}` + "\n" + big + "\n"
	code, lines, stderr, _ := runMCP(t, handler, RoomTokens{AccessToken: "access"}, stdin)
	if code != 0 || len(lines) != 3 {
		t.Fatalf("exit = %d, %d lines, stderr = %q", code, len(lines), stderr)
	}
	// The slow request only returns after the fast one was handled: had they run one at a time,
	// the handler's 10 s wait would have expired and failed the test.
	if !strings.Contains(strings.Join(lines, "\n"), `"bytes":`+itoa(len(big))) {
		t.Errorf("the 2 MiB message was not forwarded whole: %.200q", lines)
	}
}

func TestMCPNeedsARoomAndSpeaksOnlyProtocolOnStdout(t *testing.T) {
	var out, errOut bytes.Buffer
	config := filepath.Join(t.TempDir(), "room.json")
	code := Run(context.Background(), []string{"--server", "http://127.0.0.1:1", "mcp"}, strings.NewReader(""), &out, &errOut, config)
	if code != 64 || out.Len() != 0 {
		t.Fatalf("exit = %d, stdout = %q", code, out.String())
	}
	code = Run(context.Background(), []string{"--server", "http://127.0.0.1:1", "--room", "room_demo", "mcp", "extra"}, strings.NewReader(""), &out, &errOut, config)
	if code != 64 {
		t.Fatalf("exit with an argument = %d", code)
	}
}
