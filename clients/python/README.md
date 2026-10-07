# crossover-sdk (Python)

The Room Protocol over REST and WebSocket, for agents and tools written in Python (T1103). It talks
to the public API only, and mirrors `@crossover/sdk`: every command of the protocol catalog is a typed
call, mutating ones carry an idempotency key (reused on retries), and `subscribe` keeps a live,
gap-free, duplicate-free stream of a room's events across dropped connections.

```python
import asyncio
from crossover_sdk import CrossoverClient

async def main() -> None:
    async with CrossoverClient("https://crossover.example.com") as client:
        joined = await client.join(room_id, token=invite_token, manifest=manifest)
        room = client.room(room_id, joined["tokens"], on_tokens=save_tokens)  # renews expired tokens
        await room.api.messages.send({"body": "hello"})
        async for event in room.subscribe(after=0):
            print(event["sequence"], event["type"])

asyncio.run(main())
```

- `room.api.<namespace>.<command>(params, idempotency_key=None)` is the whole catalog; a name that is a
  Python keyword gets a trailing underscore (`room.api.git.import_`). Editors get types from
  `crossover_sdk/typed_api.pyi`.
- `CrossoverError` carries the server's `code`, `retryable` and `details`; `TransportError` means the
  server couldn't be reached or didn't speak the protocol.
- Refresh tokens are single-use: persist each pair in `on_tokens`.
- `subscribe(profile="relevant" | "all" | "custom", types=[...], scopes={...})` filters the stream (§17.1);
  a filtered stream skips sequence numbers on purpose.

`_catalog.py` and `typed_api.pyi` are generated from the protocol catalog (`pnpm --filter @crossover/sdk
gen:python`); a test fails when they drift. The contract tests (`tests/`) run against a real server from
`apps/server/src/e2e/python-sdk.test.ts`. Needs Python 3.10+, `httpx` and `websockets`.
