package cli

import (
	"flag"
	"strings"
)

// Limits the server enforces on sandbox.exec; checked here so a bad call fails before any request.
const (
	maxCommandBytes = 128 * 1024
	maxCwdBytes     = 4096
	maxTimeoutS     = 3600
)

// sandbox runs the commands that act on the caller's own sandbox working copy (§27). `exec`
// only starts the command and prints its exec_id; its output arrives on the sandbox.output
// stream, which is not part of this command group yet.
func (a *app) sandbox(args []string) error {
	if err := a.requireRoom(); err != nil {
		return err
	}
	if len(args) == 0 {
		return usageError("sandbox requires status, exec, or exec-cancel")
	}
	action, args := args[0], args[1:]
	switch action {
	case "status":
		positional, err := parseFlags("sandbox status", args, func(*flag.FlagSet) {})
		if err != nil {
			return err
		}
		if len(positional) != 0 {
			return usageError("sandbox status takes no arguments")
		}
		return a.command("sandbox.status", map[string]any{}, false, "")
	case "exec":
		var cwd string
		var timeout int
		positional, err := parseFlags("sandbox exec", args, func(fs *flag.FlagSet) {
			fs.StringVar(&cwd, "cwd", "", "working directory inside the sandbox")
			fs.IntVar(&timeout, "timeout-s", 0, "seconds before the command is stopped, up to 3600; the room default when omitted")
		})
		if err != nil {
			return err
		}
		if len(positional) != 1 || positional[0] == "" {
			return usageError("sandbox exec requires COMMAND (quote it as one argument)")
		}
		command := positional[0]
		if len(command) > maxCommandBytes {
			return usageError("COMMAND is at most 131072 bytes")
		}
		if strings.ContainsRune(command, 0) {
			return usageError("COMMAND must not contain NUL")
		}
		if len(cwd) > maxCwdBytes {
			return usageError("--cwd is at most 4096 bytes")
		}
		if timeout < 0 || timeout > maxTimeoutS {
			return usageError("--timeout-s must be between 1 and 3600")
		}
		params := map[string]any{"command": command}
		if cwd != "" {
			params["cwd"] = cwd
		}
		if timeout > 0 {
			params["timeout_s"] = timeout
		}
		return a.command("sandbox.exec", params, true, "")
	case "exec-cancel":
		positional, err := parseFlags("sandbox exec-cancel", args, func(*flag.FlagSet) {})
		if err != nil {
			return err
		}
		if len(positional) != 1 || !strings.HasPrefix(positional[0], "exec_") {
			return usageError("sandbox exec-cancel requires EXEC_ID (exec_...)")
		}
		return a.command("sandbox.exec.cancel", map[string]any{"exec_id": positional[0]}, true, "")
	default:
		return usageError("unknown sandbox command " + action)
	}
}
