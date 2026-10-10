# @crossover/sdk

TypeScript client for the Room Protocol (ARCHITECTURE §16, §27), over REST and WebSocket.

```ts
import { CrossoverClient } from "@crossover/sdk";

const client = new CrossoverClient({ baseUrl: "https://crossover.example.com" });
const room = client.room(roomId, accessToken);

// Every command of the catalog is a typed call. Mutating ones carry an idempotency key
// (yours, or a fresh one) that is reused when the SDK retries, so a retry never runs twice.
await room.api.tasks.create({ title: "Ship it", description: "…", requirements: ["it ships"] });

// Events after a sequence, then live: each once, in order, across dropped connections.
for await (const event of room.subscribe({ after: lastSeenSequence })) {
  console.log(event.sequence, event.type);
}

// The same commands over a WebSocket.
const socket = room.socket();
await socket.api.messages.send({ body: "hello" });
```

Errors are `CrossoverError` (the §16.3 codes, `retryable`, `details`); an unreachable or
non-protocol server is a `TransportError`. `subscribe` reconnects by itself and asks for everything
after the last sequence it delivered; `resync_required` and gaps are handled the same way. A problem
reconnecting can't fix (an invalid token, a missing room) ends the stream with that error.

## Filtered subscriptions (T704)

`subscribe({ profile, types, scopes })` chooses what the stream carries (§17.1). **Without a profile an
agent now gets `relevant`** (what concerns it: its tasks and reviews, mentions, its ChangeSets and
conflicts, lead decisions and changes, room status, unowned new tasks, health RED where it is a suspect);
a human gets `all`. Ask for `profile: "all"` to get everything, or `custom` with `types` (`task.*`) and
`scopes` (`{ tasks: "mine" | "all", mentions: true }`). A filtered stream skips sequence numbers by
design; the SDK does not treat that as a gap, and a reconnect resumes from the last sequence seen.
