package cli

import (
	"errors"
	"flag"
	"io"
	"strings"
	"unicode/utf8"
)

// Limits the server enforces on messages.send, messages.list and inbox.*; checked here so a
// bad call fails with a usage error before any request.
const (
	maxMessageBytes = 32 * 1024
	maxMentions     = 50
	maxRefs         = 20
	maxPage         = 100
	maxAck          = 100
)

// repeatedFlag collects each use of a flag as is: unlike stringList it doesn't split on commas,
// since a file path in --ref may contain one.
type repeatedFlag []string

func (r *repeatedFlag) String() string { return strings.Join(*r, " ") }
func (r *repeatedFlag) Set(value string) error {
	if value == "" {
		return errors.New("value cannot be empty")
	}
	*r = append(*r, value)
	return nil
}

func (a *app) messages(args []string) error {
	if err := a.requireRoom(); err != nil {
		return err
	}
	if len(args) == 0 {
		return usageError("messages requires send, list, or edit")
	}
	action, args := args[0], args[1:]
	switch action {
	case "send":
		var mentions, refs repeatedFlag
		var replyTo, bodyFile string
		positional, err := parseFlags("messages send", args, func(fs *flag.FlagSet) {
			fs.Var(&mentions, "mention", "participant ID to mention; may be repeated")
			fs.Var(&refs, "ref", "KIND:ID of a task, file, decision, ... to refer to; may be repeated")
			fs.StringVar(&replyTo, "reply-to", "", "message ID this replies to")
			fs.StringVar(&bodyFile, "body-file", "", "read the text from this file, or - for stdin")
		})
		if err != nil {
			return err
		}
		body, err := a.messageBody("messages send", positional, bodyFile)
		if err != nil {
			return err
		}
		params := map[string]any{"body": body}
		if len(mentions) > maxMentions {
			return usageError("at most 50 --mention values")
		}
		if len(mentions) > 0 {
			params["mentions"] = []string(mentions)
		}
		if len(refs) > maxRefs {
			return usageError("at most 20 --ref values")
		}
		if len(refs) > 0 {
			parsed := make([]map[string]string, 0, len(refs))
			for _, ref := range refs {
				kind, id, ok := strings.Cut(ref, ":")
				if !ok || kind == "" || id == "" {
					return usageError("--ref must be KIND:ID, got " + ref)
				}
				parsed = append(parsed, map[string]string{"kind": kind, "id": id})
			}
			params["refs"] = parsed
		}
		if replyTo != "" {
			params["reply_to"] = replyTo
		}
		return a.command("messages.send", params, true, "")
	case "list":
		var before, after string
		var limit int
		positional, err := parseFlags("messages list", args, func(fs *flag.FlagSet) {
			fs.StringVar(&before, "before", "", "page of messages older than this message ID")
			fs.StringVar(&after, "after", "", "page of messages newer than this message ID")
			fs.IntVar(&limit, "limit", 50, "page size, from 1 to 100")
		})
		if err != nil {
			return err
		}
		if len(positional) != 0 {
			return usageError("messages list takes no positional arguments")
		}
		if before != "" && after != "" {
			return usageError("use --before or --after, not both")
		}
		if limit < 1 || limit > maxPage {
			return usageError("--limit must be between 1 and 100")
		}
		params := map[string]any{"limit": limit}
		if before != "" {
			params["before"] = before
		}
		if after != "" {
			params["after"] = after
		}
		return a.command("messages.list", params, false, "")
	case "edit":
		var bodyFile string
		positional, err := parseFlags("messages edit", args, func(fs *flag.FlagSet) {
			fs.StringVar(&bodyFile, "body-file", "", "read the new text from this file, or - for stdin")
		})
		if err != nil {
			return err
		}
		if len(positional) == 0 {
			return usageError("messages edit requires MESSAGE_ID and the new text")
		}
		body, err := a.messageBody("messages edit", positional[1:], bodyFile)
		if err != nil {
			return err
		}
		return a.command("messages.edit", map[string]any{"message_id": positional[0], "body": body}, true, "")
	default:
		return usageError("unknown messages command " + action)
	}
}

// messageBody is the text of a message: the single positional argument, or --body-file.
func (a *app) messageBody(command string, positional []string, bodyFile string) (string, error) {
	var body string
	switch {
	case bodyFile != "" && len(positional) != 0:
		return "", usageError(command + " takes the text or --body-file, not both")
	case bodyFile == "-":
		data, err := io.ReadAll(io.LimitReader(a.stdin, maxMessageBytes+1))
		if err != nil {
			return "", localError("read stdin: " + err.Error())
		}
		body = string(data)
	case bodyFile != "":
		data, err := readFile(bodyFile, maxMessageBytes)
		if err != nil {
			return "", err
		}
		body = string(data)
	case len(positional) == 1:
		body = positional[0]
	default:
		return "", usageError(command + " requires the message text or --body-file")
	}
	if strings.TrimSpace(body) == "" {
		return "", usageError("the message text is empty")
	}
	if len(body) > maxMessageBytes {
		return "", usageError("a message is at most 32768 bytes")
	}
	if !utf8.ValidString(body) {
		return "", usageError("the message text must be UTF-8")
	}
	return body, nil
}

func (a *app) inbox(args []string) error {
	if err := a.requireRoom(); err != nil {
		return err
	}
	if len(args) == 0 {
		return usageError("inbox requires list or ack")
	}
	action, args := args[0], args[1:]
	switch action {
	case "list":
		var all bool
		var after string
		var limit int
		positional, err := parseFlags("inbox list", args, func(fs *flag.FlagSet) {
			fs.BoolVar(&all, "all", false, "include acknowledged items")
			fs.StringVar(&after, "after", "", "continue after this inbox item ID")
			fs.IntVar(&limit, "limit", 50, "page size, from 1 to 100")
		})
		if err != nil {
			return err
		}
		if len(positional) != 0 {
			return usageError("inbox list takes no positional arguments")
		}
		if limit < 1 || limit > maxPage {
			return usageError("--limit must be between 1 and 100")
		}
		params := map[string]any{"unacked_only": !all, "limit": limit}
		if after != "" {
			params["after"] = after
		}
		return a.command("inbox.list", params, false, "")
	case "ack":
		positional, err := parseFlags("inbox ack", args, func(*flag.FlagSet) {})
		if err != nil {
			return err
		}
		if len(positional) < 1 || len(positional) > maxAck {
			return usageError("inbox ack requires 1 to 100 ITEM_IDs")
		}
		return a.command("inbox.ack", map[string]any{"ids": positional}, true, "")
	default:
		return usageError("unknown inbox command " + action)
	}
}
