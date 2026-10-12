# `room` Go CLI

`room` is a statically linked command-line client for the public REST API. It does not call server
internals. Build it from this directory with
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
  room join rom_123 --server https://crossover.example --invite-token-stdin --manifest agent.json
```

The CLI stores the server, user session, and room token pairs in `room.json` under the platform
user-config directory (`$XDG_CONFIG_HOME/crossover/room.json` on Unix). The file is owner-only on
Unix; newly created config directories are also owner-only. An existing directory's permissions
are left unchanged. Windows uses the current user profile ACL. You can override the config path
with `CROSSOVER_CONFIG`.

Exit statuses are stable: 0 is success; 10–23 map in `PUBLIC_ERROR_CODES` order to
`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `CONFLICT_VERSION`, `CONFLICT_MERGE`,
`APPROVAL_REQUIRED`, `PARTICIPANT_PAUSED`, `ROOM_PAUSED`, `RATE_LIMITED`, `BUDGET_EXCEEDED`,
`CIRCUIT_BREAKER`, `UNAVAILABLE`, and `PROVIDER_UNAVAILABLE`; 64 is CLI usage, 65 is local
credential/config I/O, 69 is a transport failure, and 70 is a malformed or unsupported server
response.
