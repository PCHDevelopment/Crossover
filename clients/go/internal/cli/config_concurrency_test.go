package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const (
	configRaceHelperEnv = "CROSSOVER_CONFIG_RACE_HELPER"
	configRacePathEnv   = "CROSSOVER_CONFIG_RACE_PATH"
	configRaceServerEnv = "CROSSOVER_CONFIG_RACE_SERVER"
	configRaceRoomEnv   = "CROSSOVER_CONFIG_RACE_ROOM"
	configRaceReadyEnv  = "CROSSOVER_CONFIG_RACE_READY"
)

func TestConcurrentRefreshAndCursorSaveUseLatestRoomEntry(t *testing.T) {
	if os.Getenv(configRaceHelperEnv) != "" {
		t.Skip("helper process is only used by the parent test")
	}

	const roomID = "room_demo"
	refreshStarted := make(chan struct{}, 1)
	releaseRefresh := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/auth/refresh" {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body["refresh_token"] != "refresh-old" {
			http.Error(w, "unexpected refresh token", http.StatusBadRequest)
			return
		}
		refreshStarted <- struct{}{}
		select {
		case <-releaseRefresh:
		case <-time.After(10 * time.Second):
			http.Error(w, "test timed out", http.StatusGatewayTimeout)
			return
		}
		_, _ = fmt.Fprintln(w, `{"access_token":"access-new","refresh_token":"refresh-new"}`)
	}))
	defer server.Close()

	path := filepath.Join(t.TempDir(), "room.json")
	key := roomKey(server.URL, roomID)
	if err := saveConfig(path, &Config{Server: server.URL, Rooms: map[string]RoomTokens{
		key: {AccessToken: "access-old", RefreshToken: "refresh-old", LastSequence: 8},
	}}); err != nil {
		t.Fatal(err)
	}

	refresh := startConfigRaceHelper(t, "refresh", path, server.URL, roomID)
	select {
	case <-refreshStarted:
	case <-time.After(10 * time.Second):
		t.Fatal("refresh helper did not reach the HTTP request")
	}
	cursor := startConfigRaceHelper(t, "cursor", path, server.URL, roomID)
	waitForFile(t, cursor.readyFile)
	// The refresh handler is holding the config lock. Let the cursor process reach its
	// read-modify-write before the refresh is allowed to rotate the token pair.
	time.Sleep(50 * time.Millisecond)
	close(releaseRefresh)
	waitConfigRaceHelper(t, refresh)
	waitConfigRaceHelper(t, cursor)

	got, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	cred := got.Rooms[key]
	if cred.AccessToken != "access-new" || cred.RefreshToken != "refresh-new" {
		t.Fatalf("refresh pair = (%q, %q), want the latest pair", cred.AccessToken, cred.RefreshToken)
	}
	if cred.LastSequence != 42 {
		t.Fatalf("last sequence = %d, want cursor saved by the other process", cred.LastSequence)
	}
}

func TestConcurrentConfigProcessHelper(t *testing.T) {
	operation := os.Getenv(configRaceHelperEnv)
	if operation == "" {
		return
	}

	path := os.Getenv(configRacePathEnv)
	server := os.Getenv(configRaceServerEnv)
	roomID := os.Getenv(configRaceRoomEnv)
	readyFile := os.Getenv(configRaceReadyEnv)
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	client := newAPIClient(server, cfg, path)
	if err := os.WriteFile(readyFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	switch operation {
	case "refresh":
		if err := client.refreshRoom(context.Background(), roomID, cfg.Rooms[roomKey(server, roomID)]); err != nil {
			t.Fatal(err)
		}
	case "cursor":
		if err := client.saveCursor(roomID, 42); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatalf("unknown helper operation %q", operation)
	}
}

type configRaceHelper struct {
	cmd        *exec.Cmd
	outputFile *os.File
	outputPath string
	readyFile  string
}

func startConfigRaceHelper(t *testing.T, operation, path, server, roomID string) configRaceHelper {
	t.Helper()
	readyFile := filepath.Join(t.TempDir(), operation+".ready")
	cmd := exec.Command(os.Args[0], "-test.run=^TestConcurrentConfigProcessHelper$")
	cmd.Env = append(os.Environ(),
		configRaceHelperEnv+"="+operation,
		configRacePathEnv+"="+path,
		configRaceServerEnv+"="+server,
		configRaceRoomEnv+"="+roomID,
		configRaceReadyEnv+"="+readyFile,
	)
	outputPath := filepath.Join(filepath.Dir(readyFile), operation+".log")
	outputFile, err := os.Create(outputPath)
	if err != nil {
		t.Fatalf("create %s helper log: %v", operation, err)
	}
	cmd.Stdout = outputFile
	cmd.Stderr = outputFile
	if err := cmd.Start(); err != nil {
		_ = outputFile.Close()
		t.Fatalf("start %s helper: %v", operation, err)
	}
	helper := configRaceHelper{cmd: cmd, outputFile: outputFile, outputPath: outputPath, readyFile: readyFile}
	t.Cleanup(func() {
		if helper.cmd.ProcessState == nil && helper.cmd.Process != nil {
			_ = helper.cmd.Process.Kill()
			_ = helper.cmd.Wait()
		}
		_ = helper.outputFile.Close()
	})
	return helper
}

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("helper did not become ready")
}

func waitConfigRaceHelper(t *testing.T, helper configRaceHelper) {
	t.Helper()
	err := helper.cmd.Wait()
	_ = helper.outputFile.Close()
	if err != nil {
		data, _ := os.ReadFile(helper.outputPath)
		t.Fatalf("helper failed: %v\n%s", err, data)
	}
}
