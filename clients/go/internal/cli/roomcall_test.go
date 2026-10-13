package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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
