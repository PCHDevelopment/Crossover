package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"

	"github.com/gofrs/flock"
)

const maxConfigBytes = 1024 * 1024

type RoomTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	LastSequence int64  `json:"last_sequence,omitempty"`
}

type Config struct {
	Server      string                `json:"server,omitempty"`
	UserSession string                `json:"user_session,omitempty"`
	Rooms       map[string]RoomTokens `json:"rooms,omitempty"`
}

func configPath(override string) (string, error) {
	if override != "" {
		return override, nil
	}
	if path := os.Getenv("CROSSOVER_CONFIG"); path != "" {
		return path, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("find user config directory: %w", err)
	}
	return filepath.Join(base, "crossover", "room.json"), nil
}

func loadConfig(path string) (*Config, error) {
	cfg := &Config{Rooms: make(map[string]RoomTokens)}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open credentials: %w", err)
	}
	defer f.Close()

	data, err := io.ReadAll(io.LimitReader(f, maxConfigBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read credentials: %w", err)
	}
	if len(data) > maxConfigBytes {
		return nil, errors.New("credentials file exceeds 1 MiB")
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse credentials: %w", err)
	}
	if cfg.Rooms == nil {
		cfg.Rooms = make(map[string]RoomTokens)
	}
	return cfg, nil
}

func saveConfig(path string, cfg *Config) error {
	_, err := updateConfig(path, func(current *Config) (bool, error) {
		*current = *cloneConfig(cfg)
		return true, nil
	})
	return err
}

// updateConfig serializes a config read-modify-write across processes. Callers should
// mutate only the fields they own so unrelated room credentials survive concurrent updates.
func updateConfig(path string, update func(*Config) (bool, error)) (*Config, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create credentials directory: %w", err)
	}
	lock := flock.New(path + ".lock")
	if err := lock.Lock(); err != nil {
		return nil, fmt.Errorf("lock credentials: %w", err)
	}
	defer func() { _ = lock.Unlock() }()

	current, err := loadConfig(path)
	if err != nil {
		return nil, err
	}
	changed, err := update(current)
	if err != nil {
		return nil, err
	}
	if !changed {
		return current, nil
	}
	if err := writeConfig(path, current); err != nil {
		return nil, err
	}
	return current, nil
}

func cloneConfig(cfg *Config) *Config {
	copy := *cfg
	copy.Rooms = make(map[string]RoomTokens, len(cfg.Rooms))
	for key, tokens := range cfg.Rooms {
		copy.Rooms[key] = tokens
	}
	return &copy
}

func writeConfig(path string, cfg *Config) error {
	if cfg.Rooms == nil {
		cfg.Rooms = make(map[string]RoomTokens)
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("encode credentials: %w", err)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create credentials directory: %w", err)
	}
	f, err := os.CreateTemp(dir, ".room-credentials-*")
	if err != nil {
		return fmt.Errorf("create credentials file: %w", err)
	}
	tmp := f.Name()
	cleanup := func() {
		_ = f.Close()
		_ = os.Remove(tmp)
	}
	if err := f.Chmod(0o600); err != nil {
		cleanup()
		return fmt.Errorf("secure credentials file: %w", err)
	}
	if _, err := f.Write(append(data, '\n')); err != nil {
		cleanup()
		return fmt.Errorf("write credentials: %w", err)
	}
	if err := f.Sync(); err != nil {
		cleanup()
		return fmt.Errorf("sync credentials: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("close credentials: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		if runtime.GOOS != "windows" {
			_ = os.Remove(tmp)
			return fmt.Errorf("replace credentials: %w", err)
		}
		// Windows does not consistently replace an existing destination with Rename.
		if removeErr := os.Remove(path); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			_ = os.Remove(tmp)
			return fmt.Errorf("replace credentials: %w", err)
		}
		if renameErr := os.Rename(tmp, path); renameErr != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("replace credentials: %w", renameErr)
		}
	}
	return nil
}

func roomKey(server, roomID string) string { return server + "\n" + roomID }
