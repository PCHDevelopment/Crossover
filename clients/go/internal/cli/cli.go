package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"
)

type cliError struct {
	exitCode     int
	protocolCode string
	body         []byte
	message      string
	retryable    bool
	retryAfter   time.Duration
}

func (e *cliError) Error() string { return e.message }

func usageError(message string) *cliError     { return &cliError{exitCode: 64, message: message} }
func localError(message string) *cliError     { return &cliError{exitCode: 65, message: message} }
func transportError(message string) *cliError { return &cliError{exitCode: 69, message: message} }
func malformedError(message string) *cliError { return &cliError{exitCode: 70, message: message} }

type protocolErrorBody struct {
	Error struct {
		Code      string          `json:"code"`
		Message   string          `json:"message"`
		Retryable bool            `json:"retryable"`
		Details   json.RawMessage `json:"details,omitempty"`
	} `json:"error"`
}

type app struct {
	ctx              context.Context
	stdin            io.Reader
	stdout           io.Writer
	stderr           io.Writer
	cfg              *Config
	cfgPath          string
	server           string
	roomID           string
	client           *apiClient
	transientSecrets []string
	streamCredential RoomTokens
}

// Run executes the room CLI and returns its documented process status. configOverride is
// primarily for tests; an empty value follows CROSSOVER_CONFIG and the platform config directory.
func Run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer, configOverride string) int {
	server, roomID, args, err := extractGlobals(args)
	if err != nil {
		return reportError(stderr, err)
	}
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		_, _ = io.WriteString(stdout, usage)
		return 0
	}
	path, err := configPath(configOverride)
	if err != nil {
		return reportError(stderr, localError(err.Error()))
	}
	cfg, err := loadConfig(path)
	if err != nil {
		return reportError(stderr, localError(err.Error()))
	}
	if server == "" {
		server = os.Getenv("CROSSOVER_SERVER")
	}
	if server == "" {
		server = cfg.Server
	}
	if server != "" {
		server, err = normalizeServer(server)
		if err != nil {
			return reportError(stderr, usageError(err.Error()))
		}
		cfg.Server = server
	}
	a := &app{
		ctx: ctx, stdin: stdin, stdout: stdout, stderr: stderr,
		cfg: cfg, cfgPath: path, server: server, roomID: roomID,
	}
	if cfg.UserSession != "" {
		a.transientSecrets = append(a.transientSecrets, cfg.UserSession)
	}
	for _, cred := range cfg.Rooms {
		a.transientSecrets = append(a.transientSecrets, cred.AccessToken, cred.RefreshToken)
	}
	if a.server != "" {
		a.client = newAPIClient(a.server, a.cfg, a.cfgPath)
	}
	if err := a.dispatch(args); err != nil {
		return a.reportError(err)
	}
	return 0
}

func (a *app) reportError(err error) int {
	var original *cliError
	if !errors.As(err, &original) {
		return reportError(a.stderr, err)
	}
	redacted := *original
	secrets := append([]string(nil), a.transientSecrets...)
	if a.cfg != nil {
		secrets = append(secrets, a.cfg.UserSession)
		for _, cred := range a.cfg.Rooms {
			secrets = append(secrets, cred.AccessToken, cred.RefreshToken)
		}
	}
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		redacted.body = bytes.ReplaceAll(redacted.body, []byte(secret), []byte("[REDACTED]"))
		redacted.message = strings.ReplaceAll(redacted.message, secret, "[REDACTED]")
	}
	return reportError(a.stderr, &redacted)
}

const usage = `room - Crossover collaboration CLI

Usage:
  room login --server URL --session-token-stdin
  room join ROOM_ID --invite-token-stdin --manifest FILE
  room --room ROOM_ID tasks COMMAND
  room --room ROOM_ID workspace COMMAND
  room --room ROOM_ID events tail [--after SEQUENCE]

Global options --server URL and --room ROOM_ID may appear before or after the command.
Use --help with any command for its flags. API results are JSON on stdout; errors are on stderr.
`

func extractGlobals(args []string) (server, roomID string, rest []string, err error) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		name, value, hasValue := strings.Cut(arg, "=")
		if name != "--server" && name != "--room" {
			rest = append(rest, arg)
			continue
		}
		if !hasValue {
			if i+1 >= len(args) {
				return "", "", nil, usageError(name + " requires a value")
			}
			i++
			value = args[i]
		}
		if value == "" {
			return "", "", nil, usageError(name + " cannot be empty")
		}
		if name == "--server" {
			server = value
		} else {
			roomID = value
		}
	}
	return server, roomID, rest, nil
}

func normalizeServer(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("server must be an http(s) URL without credentials, query, or fragment")
	}
	return strings.TrimRight(raw, "/"), nil
}

func (a *app) dispatch(args []string) error {
	for _, arg := range args[1:] {
		if arg == "--help" || arg == "-h" {
			_, _ = io.WriteString(a.stdout, usage)
			return nil
		}
	}
	switch args[0] {
	case "login":
		return a.login(args[1:])
	case "join":
		return a.join(args[1:])
	case "tasks":
		return a.tasks(args[1:])
	case "workspace":
		return a.workspace(args[1:])
	case "events":
		return a.events(args[1:])
	case "--help", "-h", "help":
		_, _ = io.WriteString(a.stdout, usage)
		return nil
	default:
		return usageError("unknown command " + args[0] + "; run room --help")
	}
}

func (a *app) requireServer() error {
	if a.server == "" {
		return usageError("set --server URL or CROSSOVER_SERVER")
	}
	return nil
}

func (a *app) requireRoom() error {
	if a.roomID == "" {
		return usageError("set --room ROOM_ID")
	}
	if err := a.requireServer(); err != nil {
		return err
	}
	return nil
}

func (a *app) writeJSON(value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return malformedError("encode result: " + err.Error())
	}
	if _, err := a.stdout.Write(append(data, '\n')); err != nil {
		return localError("write output: " + err.Error())
	}
	return nil
}

func reportError(stderr io.Writer, err error) int {
	var ce *cliError
	if errors.As(err, &ce) {
		if len(ce.body) > 0 {
			_, _ = stderr.Write(append(ce.body, '\n'))
		} else {
			_, _ = fmt.Fprintf(stderr, "room: %s\n", ce.message)
		}
		return ce.exitCode
	}
	_, _ = fmt.Fprintf(stderr, "room: %s\n", err)
	return 70
}

func parseFlags(name string, args []string, configure func(*flag.FlagSet)) ([]string, error) {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	configure(fs)
	flagArgs, positional, err := interspersedFlags(fs, args)
	if err != nil {
		return nil, usageError(err.Error())
	}
	if err := fs.Parse(flagArgs); err != nil {
		return nil, usageError(err.Error())
	}
	if fs.NArg() != 0 {
		positional = append(positional, fs.Args()...)
	}
	return positional, nil
}

func interspersedFlags(fs *flag.FlagSet, args []string) (flags, positional []string, err error) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			positional = append(positional, arg)
			continue
		}
		name, _, hasValue := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		f := fs.Lookup(name)
		if f == nil {
			return nil, nil, fmt.Errorf("unknown flag %s", arg)
		}
		flags = append(flags, arg)
		if !hasValue {
			if boolFlag, ok := f.Value.(flag.Getter); ok {
				if _, isBool := boolFlag.Get().(bool); isBool {
					continue
				}
			}
			if i+1 >= len(args) {
				return nil, nil, fmt.Errorf("flag %s requires a value", arg)
			}
			i++
			flags = append(flags, args[i])
		}
	}
	return flags, positional, nil
}

func objectFromJSON(data []byte) (map[string]any, error) {
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, err
	}
	if value == nil {
		return nil, errors.New("JSON value must be an object")
	}
	return value, nil
}

func readFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, localError("open " + path + ": " + err.Error())
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, localError("read " + path + ": " + err.Error())
	}
	if int64(len(data)) > limit {
		return nil, localError(fmt.Sprintf("%s exceeds %d bytes", path, limit))
	}
	return data, nil
}

func readSecretLine(r io.Reader, label string) (string, error) {
	data, err := io.ReadAll(io.LimitReader(r, 16*1024+1))
	if err != nil {
		return "", localError("read " + label + ": " + err.Error())
	}
	if len(data) > 16*1024 {
		return "", usageError(label + " exceeds 16 KiB")
	}
	token := strings.TrimSpace(string(data))
	if token == "" {
		return "", usageError(label + " is empty")
	}
	if strings.ContainsAny(token, "\r\n") {
		return "", usageError(label + " must be one line")
	}
	return token, nil
}

func escapePath(value string) string {
	// IDs in the protocol are URL-safe, but PathEscape also protects untrusted input.
	return url.PathEscape(value)
}
