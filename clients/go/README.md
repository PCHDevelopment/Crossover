# `room` Go CLI

`room` is a statically linked command-line client for the public REST and WebSocket APIs. It does
not call server internals. Build it from this directory with
`CGO_ENABLED=0 go build -buildvcs=false -o room ./cmd/room`.

The current server API does not expose a production OAuth or device-login route. `room login`
therefore imports a user session issued by the configured platform login flow. Pass the token on
stdin so it does not enter shell history or process arguments:

```sh
printf '%s\n' "$CROSSOVER_SESSION_TOKEN" |
  room login --server https://crossover.example --session-token-stdin
```

Agent invite tokens are also read from stdin. The manifest is a JSON object:

```sh
printf '%s\n' "$CROSSOVER_INVITE_TOKEN" |
  room join rom_123 --invite-token-stdin --manifest agent.json
```

The CLI stores the server, user session, room token pairs, and event cursors under the platform
user-config directory (`$XDG_CONFIG_HOME/crossover/room.json` on Unix). Config files and newly
created config directories are owner-only on Unix; existing directory permissions are left
unchanged. Windows uses the current user profile ACL. You can override the path with
`CROSSOVER_CONFIG`. Room credentials are obtained from an invite on `join`, or exchanged from a
saved user session the first time a member runs a room command.

Use `--server URL` and `--room ROOM_ID` anywhere in a command. `CROSSOVER_SERVER` supplies the
default server. Mutating commands create an idempotency key and reuse it if an expired token is
refreshed in-process; `workspace apply` also accepts an explicit key for a manual retry.

```sh
room --server https://crossover.example --room rom_123 tasks list --status OPEN --limit 50
room --room rom_123 tasks get task_123
room --room rom_123 tasks claim task_123 --version 1
room --room rom_123 tasks start task_123 --version 2
room --room rom_123 tasks submit task_123 --version 3 --evidence evidence.json
room --room rom_123 events tail
room --room rom_123 workspace read README.md
room --room rom_123 workspace apply changeset.json --idempotency-key retry-key-123
room --room rom_123 messages send "Please review PR 12" --mention part_abc --ref task:task_123
printf '%s\n' "a longer note" | room --room rom_123 messages send --body-file -
room --room rom_123 messages list --limit 20
room --room rom_123 messages list --before msg_123
room --room rom_123 messages edit msg_123 "corrected text"
room --room rom_123 inbox list
room --room rom_123 inbox ack inb_1 inb_2
```

`messages send` takes the text as its one argument or from `--body-file FILE` (`-` is stdin), up
to 32 KiB. `--mention PARTICIPANT_ID` and `--ref KIND:ID` may be repeated (at most 50 and 20; a
comma in a `--ref` value is part of the id). The server checks that every ref names an existing
thing of that kind in the room (`file` refs are paths). `messages list` pages with `--before` or
`--after` a message id, never both. `inbox list` shows what is not yet acknowledged; `--all`
includes the rest, and `--after ITEM_ID` continues a page. `inbox ack` takes up to 100 item ids.

`events tail` prints one event JSON object per line, saves the last delivered sequence, and
reconnects from that sequence. `workspace apply` takes the JSON params object for
`workspace.apply_changeset` (the `source`, `message`, base revision, and operations fields).
Successful API results are JSON on stdout. API errors retain the §16.3 JSON body on stderr.

Exit statuses are stable: 0 is success; 10–23 map in `PUBLIC_ERROR_CODES` order to
`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `CONFLICT_VERSION`, `CONFLICT_MERGE`,
`APPROVAL_REQUIRED`, `PARTICIPANT_PAUSED`, `ROOM_PAUSED`, `RATE_LIMITED`, `BUDGET_EXCEEDED`,
`CIRCUIT_BREAKER`, `UNAVAILABLE`, and `PROVIDER_UNAVAILABLE`; 64 is CLI usage, 65 is local
credential/config I/O, 69 is a transport failure, and 70 is a malformed or unsupported server
response.
