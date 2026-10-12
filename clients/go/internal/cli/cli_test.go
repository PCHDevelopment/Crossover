package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLoginImportsSessionAndSecuresConfig(t *testing.T) {
	const session = "session-secret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/rooms" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer "+session {
			t.Errorf("session token was not sent as a bearer credential")
		}
		writeHTTPFixture(t, w, "auth-rooms-success.json")
	}))
	defer server.Close()

	path := filepath.Join(t.TempDir(), "config", "room.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"login", "--server", server.URL, "--session-token-stdin"}, strings.NewReader(session+"\n"), &stdout, &stderr, path)
	if code != 0 {
		t.Fatalf("login exit = %d, stderr = %s", code, stderr.String())
	}
	if strings.Contains(stdout.String(), session) {
		t.Fatal("login printed the session token")
	}
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server != server.URL || cfg.UserSession != session {
		t.Fatalf("saved config = %#v", cfg)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("credentials mode = %o, want owner-only", info.Mode().Perm())
	}
	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && dirInfo.Mode().Perm() != 0o755 {
		t.Fatalf("pre-existing credentials directory mode = %o, want unchanged 755", dirInfo.Mode().Perm())
	}
}

func TestSaveConfigCreatesPrivateDirectories(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix directory permission bits are not available on Windows")
	}
	path := filepath.Join(t.TempDir(), "new", "config", "room.json")
	if err := saveConfig(path, &Config{Rooms: map[string]RoomTokens{}}); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{filepath.Dir(filepath.Dir(path)), filepath.Dir(path)} {
		info, err := os.Stat(dir)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Errorf("new credentials directory %s mode = %o, want owner-only", dir, info.Mode().Perm())
		}
	}
}

func TestJoinStoresTokensWithoutPrintingThem(t *testing.T) {
	const access, refresh = "test-access", "test-refresh"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/rooms/room_demo/join" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var request struct {
			Token    string         `json:"token"`
			Manifest map[string]any `json:"manifest"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.Token != "invite-secret" || request.Manifest["name"] != "worker" {
			t.Fatalf("join request = %#v", request)
		}
		w.WriteHeader(http.StatusCreated)
		writeHTTPFixture(t, w, "auth-join-success.json")
	}))
	defer server.Close()

	dir := t.TempDir()
	manifest := filepath.Join(dir, "agent.json")
	if err := os.WriteFile(manifest, []byte(`{"name":"worker"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "room.json")
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{
		"join", "room_demo", "--server", server.URL, "--invite-token-stdin", "--manifest", manifest,
	}, strings.NewReader("invite-secret\n"), &stdout, &stderr, path)
	if code != 0 {
		t.Fatalf("join exit = %d, stderr = %s", code, stderr.String())
	}
	if strings.Contains(stdout.String(), access) || strings.Contains(stdout.String(), refresh) {
		t.Fatal("join printed room credentials")
	}
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	cred := cfg.Rooms[roomKey(server.URL, "room_demo")]
	if cred.AccessToken != access || cred.RefreshToken != refresh {
		t.Fatalf("saved room tokens = %#v", cred)
	}
}

func TestExpiredRoomTokenRefreshRetriesTheSameIdempotentCommand(t *testing.T) {
	var firstEnvelope, retryEnvelope map[string]any
	var commandAttempts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/auth/refresh":
			var request map[string]string
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Fatal(err)
			}
			if request["refresh_token"] != "refresh-old" {
				t.Errorf("refresh body = %#v", request)
			}
			writeHTTPFixture(t, w, "auth-refresh-success.json")
		case "/v1/rooms/room_demo/commands":
			var envelope map[string]any
			if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
				t.Fatal(err)
			}
			if commandAttempts.Add(1) == 1 {
				firstEnvelope = envelope
				if r.Header.Get("Authorization") != "Bearer access-old" {
					t.Errorf("first authorization = %q", r.Header.Get("Authorization"))
				}
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write(fixture(t, "error-unauthenticated.json"))
				return
			}
			retryEnvelope = envelope
			if r.Header.Get("Authorization") != "Bearer access-new" {
				t.Errorf("retry authorization = %q", r.Header.Get("Authorization"))
			}
			writeHTTPFixture(t, w, "command-success.json")
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
		}
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "room.json")
	if err := saveConfig(path, &Config{Server: server.URL, Rooms: map[string]RoomTokens{
		roomKey(server.URL, "room_demo"): {AccessToken: "access-old", RefreshToken: "refresh-old", LastSequence: 8},
	}}); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	client := newAPIClient(server.URL, cfg, path)
	if _, err := client.command(context.Background(), "room_demo", "tasks.claim", map[string]any{
		"task_id": "task_123", "expected_version": 4,
	}, true, ""); err != nil {
		t.Fatalf("command failed after refresh: %v", err)
	}
	if commandAttempts.Load() != 2 || !reflect.DeepEqual(firstEnvelope, retryEnvelope) {
		t.Fatalf("command retried %d times with envelopes %v and %v", commandAttempts.Load(), firstEnvelope, retryEnvelope)
	}
	cfg, err = loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	cred := cfg.Rooms[roomKey(server.URL, "room_demo")]
	if cred.AccessToken != "access-new" || cred.RefreshToken != "refresh-new" || cred.LastSequence != 8 {
		t.Fatalf("refreshed credentials = %#v", cred)
	}
}

func TestProtocolErrorExitCodesAreOneToOne(t *testing.T) {
	for code, want := range protocolExitCodes {
		t.Run(code, func(t *testing.T) {
			body := []byte(fmt.Sprintf(`{"error":{"code":%q,"message":"failure","retryable":false}}`, code))
			got := parseProtocolError(http.StatusBadRequest, body)
			if got.exitCode != want || got.protocolCode != code {
				t.Fatalf("parseProtocolError = %#v, want exit %d", got, want)
			}
		})
	}
}

func TestRetryableErrorHonorsRetryAfterAndReusesCommandEnvelope(t *testing.T) {
	var firstEnvelope, retryEnvelope map[string]any
	var attempts atomic.Int32
	var firstAttempt, secondAttempt time.Time
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var envelope map[string]any
		if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
			t.Fatal(err)
		}
		if attempts.Add(1) == 1 {
			firstAttempt = time.Now()
			firstEnvelope = envelope
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write(fixture(t, "error-rate-limited.json"))
			return
		}
		secondAttempt = time.Now()
		retryEnvelope = envelope
		writeHTTPFixture(t, w, "command-success.json")
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "room.json")
	if err := saveConfig(path, &Config{Server: server.URL, Rooms: map[string]RoomTokens{
		roomKey(server.URL, "room_demo"): {AccessToken: "access"},
	}}); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	client := newAPIClient(server.URL, cfg, path)
	if _, err := client.command(context.Background(), "room_demo", "tasks.claim", map[string]any{
		"task_id": "task_123", "expected_version": 4,
	}, true, ""); err != nil {
		t.Fatalf("command failed after retry: %v", err)
	}
	if attempts.Load() != 2 || !reflect.DeepEqual(firstEnvelope, retryEnvelope) {
		t.Fatalf("attempts=%d envelopes=%v and %v", attempts.Load(), firstEnvelope, retryEnvelope)
	}
	if elapsed := secondAttempt.Sub(firstAttempt); elapsed < 20*time.Millisecond {
		t.Fatalf("retry ignored details.retry_after: elapsed %s", elapsed)
	}
}

func TestLoginRedactsSessionTokenFromAPIError(t *testing.T) {
	const session = "session-secret-in-error"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = fmt.Fprintf(w, `{"error":{"code":"UNAUTHENTICATED","message":"invalid %s","retryable":false}}`, session)
	}))
	defer server.Close()
	var stdout, stderr bytes.Buffer
	code := Run(context.Background(), []string{"login", "--server", server.URL, "--session-token-stdin"},
		strings.NewReader(session+"\n"), &stdout, &stderr, filepath.Join(t.TempDir(), "room.json"))
	if code != 10 {
		t.Fatalf("login exit = %d, stderr = %s", code, stderr.String())
	}
	if strings.Contains(stderr.String(), session) || !strings.Contains(stderr.String(), "[REDACTED]") {
		t.Fatalf("stderr did not safely redact the session token: %s", stderr.String())
	}
}

func TestUnknownProtocolErrorUsesMalformedResponseStatus(t *testing.T) {
	got := parseProtocolError(http.StatusBadRequest, []byte(`{"error":{"code":"FUTURE_ERROR","message":"future","retryable":false}}`))
	if got.exitCode != 70 {
		t.Fatalf("unknown protocol code exit = %d, want 70", got.exitCode)
	}
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../../.."))
	data, err := os.ReadFile(filepath.Join(root, "clients", "contract-fixtures", name))
	if err != nil {
		t.Fatalf("read contract fixture %s: %v", name, err)
	}
	return data
}

func writeHTTPFixture(t *testing.T, w http.ResponseWriter, name string) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(fixture(t, name))
}
