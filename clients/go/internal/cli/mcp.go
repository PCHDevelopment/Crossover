package cli

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
)

const (
	maxMCPLine      = 16 * 1024 * 1024 // one JSON-RPC message per line
	maxMCPInFlight  = 8
	jsonRPCParse    = -32700
	jsonRPCInternal = -32603
)

// mcp is `room mcp`, the stdio shim for the server's remote MCP endpoint (§15.4): an MCP client
// that can only spawn a local process talks to it with newline-delimited JSON-RPC on
// stdin/stdout, and each message is POSTed to {server}/mcp with the room's access token. Only
// protocol messages go to stdout; diagnostics go to stderr, and no token is ever written. It runs
// until stdin closes, after the messages already sent have been answered.
func (a *app) mcp(args []string) error {
	positional, err := parseFlags("mcp", args, func(*flag.FlagSet) {})
	if err != nil {
		return err
	}
	if len(positional) != 0 {
		return usageError("mcp takes no arguments")
	}
	if err := a.requireRoom(); err != nil {
		return err
	}
	shim := &mcpShim{
		app: a, stdout: a.stdout,
		// Tool calls can run for minutes: no overall timeout, only the caller's context.
		http: &http.Client{},
	}
	reader := bufio.NewReaderSize(a.stdin, 64*1024)
	slots := make(chan struct{}, maxMCPInFlight)
	var inFlight sync.WaitGroup
	defer inFlight.Wait()
	for {
		line, tooLong, err := readMCPLine(reader)
		if len(bytes.TrimSpace(line)) > 0 || tooLong {
			switch {
			case tooLong:
				shim.write(rpcError(nil, jsonRPCParse, "message exceeds 16 MiB"))
			case !json.Valid(line):
				shim.write(rpcError(nil, jsonRPCParse, "Parse error"))
			default:
				select {
				case slots <- struct{}{}:
				case <-a.ctx.Done():
					return a.ctx.Err()
				}
				inFlight.Add(1)
				go func(message []byte) {
					defer func() { <-slots; inFlight.Done() }()
					shim.forward(a.ctx, message)
				}(line)
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return localError("read stdin: " + err.Error())
		}
	}
}

// readMCPLine reads one line, dropping what exceeds the limit (tooLong) instead of buffering it.
func readMCPLine(r *bufio.Reader) (line []byte, tooLong bool, err error) {
	for {
		chunk, isPrefix, readErr := r.ReadLine()
		if !tooLong {
			if len(line)+len(chunk) > maxMCPLine {
				tooLong, line = true, nil
			} else {
				line = append(line, chunk...)
			}
		}
		if readErr != nil || !isPrefix {
			return line, tooLong, readErr
		}
	}
}

type mcpShim struct {
	app    *app
	http   *http.Client
	mu     sync.Mutex // stdout lines, and the credential file reads/refreshes behind a.client
	stdout io.Writer
}

func (s *mcpShim) write(message []byte) {
	var compact bytes.Buffer
	if err := json.Compact(&compact, message); err != nil {
		return // not JSON: nothing a client could parse
	}
	compact.WriteByte('\n')
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.stdout.Write(compact.Bytes())
}

// redact hides every credential this process has used from text that came from an error.
func (s *mcpShim) redact(text string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, secret := range s.app.transientSecrets {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, "[REDACTED]")
		}
	}
	return text
}

func (s *mcpShim) diag(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = fmt.Fprintf(s.app.stderr, "room mcp: %s\n", text)
}

// forward sends one client message (a request, a notification, or a batch) to the server and
// writes the answers. A failure becomes a JSON-RPC error for each request in the message.
func (s *mcpShim) forward(ctx context.Context, message []byte) {
	status, contentType, body, err := s.post(ctx, message)
	if err == nil && status == http.StatusUnauthorized {
		err = s.refresh(ctx)
		if err == nil {
			status, contentType, body, err = s.post(ctx, message)
		}
	}
	switch {
	case err != nil:
		s.fail(message, jsonRPCInternal, err.Error(), nil)
	case status == http.StatusAccepted || status == http.StatusNoContent:
		// A notification or a response: there is no answer.
	case status < 200 || status >= 300:
		perr := parseProtocolError(status, body)
		s.fail(message, jsonRPCInternal, perr.message, json.RawMessage(perr.body))
	case strings.HasPrefix(contentType, "text/event-stream"):
		for _, event := range sseData(body) {
			s.write(event)
		}
	default:
		s.write(body)
	}
}

func (s *mcpShim) post(ctx context.Context, message []byte) (status int, contentType string, body []byte, err error) {
	s.mu.Lock()
	cred, credErr := s.app.client.roomCredentials(ctx, s.app.roomID)
	if credErr == nil {
		s.app.transientSecrets = append(s.app.transientSecrets, cred.AccessToken)
	}
	s.mu.Unlock()
	if credErr != nil {
		return 0, "", nil, credErr
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.app.server+"/mcp", bytes.NewReader(message))
	if err != nil {
		return 0, "", nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cred.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := s.http.Do(req)
	if err != nil {
		return 0, "", nil, fmt.Errorf("transport: %w", err)
	}
	defer resp.Body.Close()
	body, err = io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return 0, "", nil, errors.New("could not read the server response")
	}
	return resp.StatusCode, resp.Header.Get("Content-Type"), body, nil
}

func (s *mcpShim) refresh(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cred, err := s.app.client.roomCredentials(ctx, s.app.roomID)
	if err != nil {
		return err
	}
	return s.app.client.refreshRoom(ctx, s.app.roomID, cred)
}

// fail answers every request in message (those with a method and an id) with a JSON-RPC error.
func (s *mcpShim) fail(message []byte, code int, text string, data json.RawMessage) {
	text = s.redact(text)
	if len(data) > 0 {
		data = json.RawMessage(s.redact(string(data)))
	}
	s.diag(text)
	var items []json.RawMessage
	if json.Unmarshal(message, &items) != nil {
		items = []json.RawMessage{message}
	}
	for _, item := range items {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(item, &request) != nil || request.Method == "" || len(request.ID) == 0 || string(request.ID) == "null" {
			continue
		}
		s.write(rpcErrorWithData(request.ID, code, text, data))
	}
}

func rpcError(id json.RawMessage, code int, text string) []byte {
	return rpcErrorWithData(id, code, text, nil)
}

func rpcErrorWithData(id json.RawMessage, code int, text string, data json.RawMessage) []byte {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	failure := map[string]any{"code": code, "message": text}
	if len(data) > 0 {
		failure["data"] = data
	}
	out, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "error": failure})
	return out
}

// sseData returns the data of each event of a text/event-stream body, in order.
func sseData(body []byte) [][]byte {
	var events [][]byte
	var current []string
	flush := func() {
		if len(current) > 0 {
			events = append(events, []byte(strings.Join(current, "\n")))
			current = nil
		}
	}
	for _, raw := range strings.Split(string(body), "\n") {
		line := strings.TrimRight(raw, "\r")
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, "data:"):
			current = append(current, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	flush()
	return events
}
