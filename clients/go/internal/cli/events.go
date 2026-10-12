package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
)

const (
	protocolVersion = 1
	clientVersion   = "0.1.0"
)

func (a *app) events(args []string) error {
	if err := a.requireRoom(); err != nil {
		return err
	}
	if len(args) == 0 || args[0] != "tail" {
		return usageError("events requires tail")
	}
	var after int64 = -1
	positional, err := parseFlags("events tail", args[1:], func(fs *flag.FlagSet) {
		fs.Int64Var(&after, "after", -1, "resume after this event sequence")
	})
	if err != nil {
		return err
	}
	if len(positional) != 0 || after < -1 {
		return usageError("events tail accepts only --after SEQUENCE")
	}
	cred, err := a.client.roomCredentials(a.ctx, a.roomID)
	if err != nil {
		return err
	}
	cursor := cred.LastSequence
	if after >= 0 {
		cursor = after
	}
	delay := 250 * time.Millisecond
	for a.ctx.Err() == nil {
		retry, err := a.streamOnce(&cursor)
		if a.ctx.Err() != nil {
			return nil
		}
		if err != nil {
			var ce *cliError
			if errors.As(err, &ce) && ce.protocolCode == "UNAUTHENTICATED" {
				if refreshErr := a.client.refreshRoom(a.ctx, a.roomID, a.streamCredential); refreshErr != nil {
					return refreshErr
				}
				delay = 250 * time.Millisecond
				continue
			}
			if errors.As(err, &ce) && ce.retryable {
				wait := ce.retryAfter
				if wait <= 0 {
					wait = delay
				}
				if !sleepContext(a.ctx, wait) {
					return nil
				}
				delay = 250 * time.Millisecond
				continue
			}
			if errors.As(err, &ce) && ce.exitCode != 69 {
				return err
			}
			// Network interruptions are expected for a tail; reconnect from the last saved event.
			retry = true
		}
		if !retry {
			return nil
		}
		if !sleepContext(a.ctx, delay) {
			return nil
		}
		if delay < 5*time.Second {
			delay *= 2
			if delay > 5*time.Second {
				delay = 5 * time.Second
			}
		}
	}
	return nil
}

func (a *app) streamOnce(cursor *int64) (retry bool, err error) {
	cred, err := a.client.roomCredentials(a.ctx, a.roomID)
	if err != nil {
		return false, err
	}
	a.streamCredential = cred
	u, err := url.Parse(a.server + "/v1/rooms/" + escapePath(a.roomID) + "/ws")
	if err != nil {
		return false, malformedError("build WebSocket URL: " + err.Error())
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else if u.Scheme == "http" {
		u.Scheme = "ws"
	} else {
		return false, usageError("server URL must use http or https")
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+cred.AccessToken)
	conn, response, err := websocket.DefaultDialer.DialContext(a.ctx, u.String(), headers)
	if err != nil {
		if response != nil {
			defer response.Body.Close()
			data, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
			if readErr != nil {
				return false, transportError("read WebSocket rejection: " + readErr.Error())
			}
			apiErr := parseProtocolError(response.StatusCode, data)
			applyRetryAfter(apiErr, response.Header.Get("Retry-After"))
			return false, apiErr
		}
		if a.ctx.Err() != nil {
			return false, nil
		}
		return true, transportError(err.Error())
	}
	defer conn.Close()
	conn.SetReadLimit(maxResponseBytes)
	stopClose := context.AfterFunc(a.ctx, func() { _ = conn.Close() })
	defer stopClose()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	if err := conn.WriteJSON(map[string]any{
		"type": "hello", "protocol_version": protocolVersion, "client": "room", "client_version": clientVersion,
		"token": cred.AccessToken,
	}); err != nil {
		if a.ctx.Err() != nil {
			return false, nil
		}
		return true, transportError("send hello: " + err.Error())
	}
	var hello map[string]json.RawMessage
	if err := conn.ReadJSON(&hello); err != nil {
		if a.ctx.Err() != nil {
			return false, nil
		}
		if closeCode(err) == 4401 {
			return false, unauthenticatedClose()
		}
		return true, transportError("read hello response: " + err.Error())
	}
	var helloType string
	_ = json.Unmarshal(hello["type"], &helloType)
	if helloType == "error" {
		return false, protocolFrameError(hello["error"])
	}
	if helloType != "hello_ok" {
		return false, malformedError("WebSocket server did not acknowledge hello")
	}
	_ = conn.SetReadDeadline(time.Time{})
	if err := conn.WriteJSON(map[string]any{"type": "subscribe", "after": *cursor}); err != nil {
		if a.ctx.Err() != nil {
			return false, nil
		}
		return true, transportError("subscribe to events: " + err.Error())
	}
	for {
		var frame map[string]json.RawMessage
		if err := conn.ReadJSON(&frame); err != nil {
			if a.ctx.Err() != nil {
				return false, nil
			}
			if closeCode(err) == 4401 {
				return false, unauthenticatedClose()
			}
			if closeCode(err) == 4409 {
				return true, nil
			}
			return true, transportError("event stream disconnected: " + err.Error())
		}
		var frameType string
		if err := json.Unmarshal(frame["type"], &frameType); err != nil {
			return false, malformedError("WebSocket frame has no type")
		}
		switch frameType {
		case "subscribed", "pong":
			continue
		case "resync_required":
			return true, nil
		case "error":
			return false, protocolFrameError(frame["error"])
		case "event":
			event := frame["event"]
			var meta struct {
				Sequence int64 `json:"sequence"`
			}
			if len(event) == 0 || json.Unmarshal(event, &meta) != nil || meta.Sequence < 1 {
				return false, malformedError("event frame has no positive sequence")
			}
			if meta.Sequence <= *cursor {
				continue
			}
			var compact bytes.Buffer
			if err := json.Compact(&compact, event); err != nil {
				return false, malformedError("event frame contains invalid JSON")
			}
			if _, err := fmt.Fprintln(a.stdout, compact.String()); err != nil {
				return false, localError("write event: " + err.Error())
			}
			*cursor = meta.Sequence
			if err := a.client.saveCursor(a.roomID, *cursor); err != nil {
				return false, err
			}
		default:
			// Future protocol frames do not change the event cursor.
			continue
		}
	}
}

func protocolFrameError(raw json.RawMessage) *cliError {
	if len(raw) == 0 || !json.Valid(raw) {
		return malformedError("WebSocket error frame has no valid §16.3 error")
	}
	body := append([]byte(`{"error":`), raw...)
	body = append(body, '}')
	return parseProtocolError(http.StatusBadRequest, body)
}

func unauthenticatedClose() *cliError {
	body := []byte(`{"error":{"code":"UNAUTHENTICATED","message":"WebSocket token expired","retryable":false}}`)
	return parseProtocolError(http.StatusUnauthorized, body)
}

func closeCode(err error) int {
	var closeErr *websocket.CloseError
	if errors.As(err, &closeErr) {
		return closeErr.Code
	}
	return 0
}
