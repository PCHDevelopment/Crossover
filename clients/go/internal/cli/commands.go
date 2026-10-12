package cli

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"strings"
)

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(value string) error {
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			return errors.New("status cannot be empty")
		}
		*s = append(*s, part)
	}
	return nil
}

func (a *app) tasks(args []string) error {
	if err := a.requireRoom(); err != nil {
		return err
	}
	if len(args) == 0 {
		return usageError("tasks requires list, get, claim, start, or submit")
	}
	action, args := args[0], args[1:]
	params := make(map[string]any)
	mutating := false
	switch action {
	case "list":
		var statuses stringList
		var mine bool
		var owner, cursor string
		var limit int
		positional, err := parseFlags("tasks list", args, func(fs *flag.FlagSet) {
			fs.Var(&statuses, "status", "filter by status; may be repeated or comma-separated")
			fs.BoolVar(&mine, "mine", false, "list tasks owned by the current participant")
			fs.StringVar(&owner, "owner", "", "filter by participant ID")
			fs.StringVar(&cursor, "cursor", "", "continue from an opaque next_cursor")
			fs.IntVar(&limit, "limit", 50, "page size, from 1 to 100")
		})
		if err != nil {
			return err
		}
		if len(positional) != 0 {
			return usageError("tasks list takes no positional arguments")
		}
		if len(statuses) > 0 {
			params["status"] = []string(statuses)
		}
		if mine {
			params["mine"] = true
		}
		if owner != "" {
			params["owner_id"] = owner
		}
		if cursor != "" {
			params["cursor"] = cursor
		}
		if limit < 1 || limit > 100 {
			return usageError("--limit must be between 1 and 100")
		}
		params["limit"] = limit
		return a.command("tasks.list", params, false, "")
	case "get":
		positional, err := parseFlags("tasks get", args, func(*flag.FlagSet) {})
		if err != nil {
			return err
		}
		if len(positional) != 1 {
			return usageError("tasks get requires TASK_ID")
		}
		params["task_id"] = positional[0]
		return a.command("tasks.get", params, false, "")
	case "claim", "start", "submit":
		var version int
		var evidencePath string
		positional, err := parseFlags("tasks "+action, args, func(fs *flag.FlagSet) {
			fs.IntVar(&version, "version", 0, "task version you last observed")
			if action == "submit" {
				fs.StringVar(&evidencePath, "evidence", "", "JSON evidence array")
			}
		})
		if err != nil {
			return err
		}
		if len(positional) != 1 || version < 1 {
			return usageError("tasks " + action + " requires TASK_ID and --version N")
		}
		params["task_id"] = positional[0]
		params["expected_version"] = version
		if action == "submit" && evidencePath != "" {
			data, err := readFile(evidencePath, 1024*1024)
			if err != nil {
				return err
			}
			var evidence []any
			if err := json.Unmarshal(data, &evidence); err != nil || evidence == nil {
				return usageError("--evidence must contain a JSON array")
			}
			params["evidence"] = evidence
		}
		mutating = true
		return a.command("tasks."+action, params, mutating, "")
	default:
		return usageError(fmt.Sprintf("unknown tasks command %s", action))
	}
}

func (a *app) workspace(args []string) error {
	if err := a.requireRoom(); err != nil {
		return err
	}
	if len(args) == 0 {
		return usageError("workspace requires read or apply")
	}
	action, args := args[0], args[1:]
	switch action {
	case "read":
		positional, err := parseFlags("workspace read", args, func(*flag.FlagSet) {})
		if err != nil {
			return err
		}
		if len(positional) != 1 {
			return usageError("workspace read requires PATH")
		}
		return a.command("workspace.read", map[string]any{"path": positional[0]}, false, "")
	case "apply":
		var key string
		positional, err := parseFlags("workspace apply", args, func(fs *flag.FlagSet) {
			fs.StringVar(&key, "idempotency-key", "", "stable key to make a manual retry replay safely")
		})
		if err != nil {
			return err
		}
		if len(positional) != 1 {
			return usageError("workspace apply requires PARAMS.json")
		}
		data, err := readFile(positional[0], 32*1024*1024)
		if err != nil {
			return err
		}
		params, err := objectFromJSON(data)
		if err != nil {
			return usageError("ChangeSet parameters must be a JSON object: " + err.Error())
		}
		return a.command("workspace.apply_changeset", params, true, key)
	default:
		return usageError("workspace requires read or apply")
	}
}

func (a *app) command(method string, params map[string]any, mutating bool, key string) error {
	if err := a.requireRoom(); err != nil {
		return err
	}
	data, err := a.client.command(a.ctx, a.roomID, method, params, mutating, key)
	if err != nil {
		return err
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return malformedError("decode command result: " + err.Error())
	}
	return a.writeJSON(value)
}
