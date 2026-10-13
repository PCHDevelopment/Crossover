package cli

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	maxResponseBytes = 64 * 1024 * 1024
	maxRetryAfter    = 60 * time.Second
)

func sleepContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

type apiClient struct {
	server  string
	cfg     *Config
	cfgPath string
	http    *http.Client
}

func newAPIClient(server string, cfg *Config, cfgPath string) *apiClient {
	return &apiClient{
		server: server, cfg: cfg, cfgPath: cfgPath,
		http: &http.Client{Timeout: 45 * time.Second},
	}
}

func (c *apiClient) requestJSON(ctx context.Context, method, path, token string, body []byte) ([]byte, error) {
	endpoint := c.server + path
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytesReader(body))
	if err != nil {
		return nil, malformedError("build request: " + err.Error())
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, transportError(err.Error())
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, transportError("read response: " + err.Error())
	}
	if len(data) > maxResponseBytes {
		return nil, malformedError("server response exceeds 64 MiB")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		apiErr := parseProtocolError(resp.StatusCode, data)
		applyRetryAfter(apiErr, resp.Header.Get("Retry-After"))
		return nil, apiErr
	}
	if !json.Valid(data) {
		return nil, malformedError("server returned invalid JSON")
	}
	return data, nil
}

func (c *apiClient) requestJSONRetryable(ctx context.Context, method, path, token string, body []byte) ([]byte, error) {
	for retry := 0; ; retry++ {
		data, err := c.requestJSON(ctx, method, path, token, body)
		if err == nil {
			return data, nil
		}
		apiErr, ok := err.(*cliError)
		if !ok || !apiErr.retryable || retry >= 2 {
			return nil, err
		}
		delay := apiErr.retryAfter
		if delay <= 0 {
			delay = 250 * time.Millisecond * time.Duration(1<<retry)
		}
		if !sleepContext(ctx, delay) {
			return nil, ctx.Err()
		}
	}
}

func parseRetryAfter(raw string) time.Duration {
	if seconds, err := strconv.ParseFloat(strings.TrimSpace(raw), 64); err == nil && seconds >= 0 {
		if seconds > maxRetryAfter.Seconds() {
			return maxRetryAfter
		}
		return time.Duration(seconds * float64(time.Second))
	}
	if date, err := http.ParseTime(raw); err == nil {
		delay := time.Until(date)
		if delay > 0 {
			if delay > maxRetryAfter {
				return maxRetryAfter
			}
			return delay
		}
	}
	return 0
}

func applyRetryAfter(apiErr *cliError, raw string) {
	if retryAfter := parseRetryAfter(raw); retryAfter > apiErr.retryAfter {
		apiErr.retryAfter = retryAfter
	}
}

// bytesReader avoids retaining a second copy of large ChangeSet request bodies.
func bytesReader(body []byte) io.Reader {
	if body == nil {
		return nil
	}
	return bytes.NewReader(body)
}

func parseProtocolError(status int, data []byte) *cliError {
	var body protocolErrorBody
	if err := json.Unmarshal(data, &body); err != nil || body.Error.Code == "" {
		return malformedError(fmt.Sprintf("server returned HTTP %d without a §16.3 error body", status))
	}
	code, ok := protocolExitCodes[body.Error.Code]
	if !ok {
		return malformedError("server returned unknown protocol error " + body.Error.Code)
	}
	message := body.Error.Message
	if message == "" {
		message = body.Error.Code
	}
	var details struct {
		RetryAfter float64 `json:"retry_after"`
	}
	if len(body.Error.Details) != 0 {
		_ = json.Unmarshal(body.Error.Details, &details)
	}
	retryAfter := time.Duration(0)
	if details.RetryAfter > 0 {
		seconds := details.RetryAfter
		if seconds > maxRetryAfter.Seconds() {
			seconds = maxRetryAfter.Seconds()
		}
		retryAfter = time.Duration(seconds * float64(time.Second))
	}
	return &cliError{
		exitCode: code, protocolCode: body.Error.Code, body: append([]byte(nil), data...),
		message: message, retryable: body.Error.Retryable, retryAfter: retryAfter,
	}
}

func (c *apiClient) command(ctx context.Context, roomID, method string, params map[string]any, mutating bool, key string) ([]byte, error) {
	if err := c.ensureServer(); err != nil {
		return nil, err
	}
	cred, err := c.roomCredentials(ctx, roomID)
	if err != nil {
		return nil, err
	}
	commandID, err := newID("cmd")
	if err != nil {
		return nil, localError("generate command id: " + err.Error())
	}
	envelope := map[string]any{"id": commandID, "method": method, "params": params}
	if mutating {
		if key == "" {
			key, err = randomKey()
			if err != nil {
				return nil, localError("generate idempotency key: " + err.Error())
			}
		}
		envelope["idempotency_key"] = key
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		return nil, malformedError("encode command: " + err.Error())
	}
	path := "/v1/rooms/" + url.PathEscape(roomID) + "/commands"
	response, err := c.requestJSONRetryable(ctx, http.MethodPost, path, cred.AccessToken, body)
	if apiError, ok := err.(*cliError); ok && apiError.protocolCode == "UNAUTHENTICATED" && cred.RefreshToken != "" {
		if refreshErr := c.refreshRoom(ctx, roomID, cred); refreshErr != nil {
			return nil, refreshErr
		}
		cred, err = c.roomCredentials(ctx, roomID)
		if err != nil {
			return nil, err
		}
		response, err = c.requestJSONRetryable(ctx, http.MethodPost, path, cred.AccessToken, body)
	}
	return response, err
}

func (c *apiClient) roomCredentials(ctx context.Context, roomID string) (RoomTokens, error) {
	latest, err := loadConfig(c.cfgPath)
	if err != nil {
		return RoomTokens{}, localError(err.Error())
	}
	*c.cfg = *latest
	key := roomKey(c.server, roomID)
	if cred, ok := c.cfg.Rooms[key]; ok && cred.AccessToken != "" {
		return cred, nil
	}
	if c.cfg.UserSession == "" {
		return RoomTokens{}, localError("no room credentials; run room join or room login first")
	}
	body, err := json.Marshal(map[string]any{})
	if err != nil {
		return RoomTokens{}, malformedError("encode room session request: " + err.Error())
	}
	data, err := c.requestJSON(ctx, http.MethodPost, "/v1/rooms/"+url.PathEscape(roomID)+"/session", c.cfg.UserSession, body)
	if err != nil {
		return RoomTokens{}, err
	}
	var response struct {
		Tokens RoomTokens `json:"tokens"`
	}
	if err := json.Unmarshal(data, &response); err != nil || response.Tokens.AccessToken == "" {
		return RoomTokens{}, malformedError("room session response has no tokens")
	}
	var stored RoomTokens
	updated, err := updateConfig(c.cfgPath, func(current *Config) (bool, error) {
		if cred, ok := current.Rooms[key]; ok && cred.AccessToken != "" {
			stored = cred
			return false, nil
		}
		current.Rooms[key] = response.Tokens
		stored = response.Tokens
		return true, nil
	})
	if err != nil {
		return RoomTokens{}, localError("save room credentials: " + err.Error())
	}
	*c.cfg = *updated
	return stored, nil
}

func (c *apiClient) refreshRoom(ctx context.Context, roomID string, failed RoomTokens) error {
	key := roomKey(c.server, roomID)
	updated, err := updateConfig(c.cfgPath, func(current *Config) (bool, error) {
		cred, ok := current.Rooms[key]
		if !ok || cred.RefreshToken == "" {
			return false, localError("no refresh token for this room; join again")
		}
		if cred.AccessToken != failed.AccessToken || cred.RefreshToken != failed.RefreshToken {
			// Another process already rotated the pair while this request was in flight.
			return false, nil
		}
		body, err := json.Marshal(map[string]string{"refresh_token": cred.RefreshToken})
		if err != nil {
			return false, malformedError("encode refresh request: " + err.Error())
		}
		data, err := c.requestJSON(ctx, http.MethodPost, "/v1/auth/refresh", "", body)
		if err != nil {
			return false, err
		}
		var pair RoomTokens
		if err := json.Unmarshal(data, &pair); err != nil || pair.AccessToken == "" || pair.RefreshToken == "" {
			return false, malformedError("refresh response has no token pair")
		}
		pair.LastSequence = cred.LastSequence
		current.Rooms[key] = pair
		return true, nil
	})
	if err != nil {
		return err
	}
	*c.cfg = *updated
	return nil
}

func (c *apiClient) saveCursor(roomID string, sequence int64) error {
	key := roomKey(c.server, roomID)
	updated, err := updateConfig(c.cfgPath, func(current *Config) (bool, error) {
		cred, ok := current.Rooms[key]
		if !ok {
			return false, localError("room credentials disappeared while tailing events")
		}
		if sequence <= cred.LastSequence {
			return false, nil
		}
		cred.LastSequence = sequence
		current.Rooms[key] = cred
		return true, nil
	})
	if err != nil {
		return localError("save event cursor: " + err.Error())
	}
	*c.cfg = *updated
	return nil
}

func (c *apiClient) ensureServer() error {
	if c.server == "" {
		return usageError("set --server URL or CROSSOVER_SERVER")
	}
	return nil
}

func randomKey() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func newID(prefix string) (string, error) {
	if prefix == "" {
		return "", fmt.Errorf("empty ID prefix")
	}
	var random [10]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	ms := uint64(time.Now().UnixMilli()) & ((1 << 48) - 1)
	value := new(big.Int).SetUint64(ms)
	value.Lsh(value, 80)
	value.Or(value, new(big.Int).SetBytes(random[:]))
	base := big.NewInt(32)
	rem := new(big.Int)
	encoded := make([]byte, 26)
	for i := len(encoded) - 1; i >= 0; i-- {
		value.QuoRem(value, base, rem)
		encoded[i] = crockford[rem.Int64()]
	}
	return prefix + "_" + string(encoded), nil
}
