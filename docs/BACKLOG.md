# Backlog — Phase 1 core

Tasks for the Phase 1 backend core: ledger, governance, tasks, collaboration state, workspace engine, conflicts, health, gateway and MCP. Sandboxes (§14) are M10 and the clients (SDKs, CLI, web app; §27, §29) are M11. The plugin runner (§21.4) is M12.

Conventions are in `docs/ENGINEERING.md`. Section references (§) point to `docs/ARCHITECTURE.md`.

**Status** lives in the SharedNet room and on the PRs (and in Chorus once it's set up). This file holds specs and owners; O1 updates it when specs change.

**Reading a task:** _Deps_ must be merged before you start. _Migration_ is the file number you must use. Every task also implicitly requires: tests for the acceptance criteria, `pnpm check` green, and no unrelated changes.

## Ownership at a glance

| Milestone                             | Tasks       | Owner                                                   |
| ------------------------------------- | ----------- | ------------------------------------------------------- |
| M0 Foundation                         | T000        | O1                                                      |
| M1 Persistence, ledger, commands      | T101–T118   | S1                                                      |
| M2 Rooms, participants, auth, policy  | T201–T215   | S1                                                      |
| M3 Tasks                              | T301–T312   | S1                                                      |
| M4 Messages, inbox, decisions, memory | T401–T412   | S1 (moved from S2 for T404–T409, T411–T412 in Review 3) |
| M5 Workspace engine                   | T501–T520   | S2                                                      |
| M6 Conflicts and health               | T601–T610   | S2                                                      |
| M7 Gateway, MCP, end-to-end           | T701–T713   | S1 (T701–T709, T713), S2 (T710–T711), O1 (T712)         |
| M8 Git interoperability (§24)         | T801–T806   | S1 (moved from S2 in Review 4)                          |
| M9 Safety controls (§22–23)           | T901–T906   | S1 (T902, T904–T906), S2 (T901, T903)                   |
| M10 Execution sandboxes (§14)         | T1001–T1008 | S2                                                      |
| M11 Clients (§27, §29)                | T1101–T1105 | S1                                                      |
| M12 Plugins (§21.4–21.5)              | T1201–T1206 | S2                                                      |
| M13 Lessons from building (§34)       | T1301–T1303 | S1                                                      |

**Start here:** S1 → T101, T105, T114 (independent). S2 → T501, T505 (only need the scaffold).

---

## M0 Foundation

### T000 · Monorepo scaffold — O1

Deps: — · Migration: —

pnpm workspace, TS strict base config, ESLint, Prettier, Vitest, CI, docker-compose (PostgreSQL 16, Redis 7), `packages/protocol` stub, engineering guide and this backlog.

- `pnpm check` passes locally and in CI.

---

## M1 Persistence, ledger, commands — S1

### T101 · db: pool and transactions

Deps: T000 · Migration: —

Create `packages/db`. Export `createPool(url)` (reads `DATABASE_URL` when omitted) and `withTransaction(pool, fn)` that runs `fn(client)` inside `BEGIN … COMMIT`, rolling back and rethrowing if `fn` throws.

- Commit persists; a throw rolls back and rethrows the original error.
- Client is always released, including on error.
- Integration test against the docker-compose database.

### T102 · db: migration runner

Deps: T101 · Migration: —

SQL files in `packages/db/migrations/NNNN_name.sql` applied in order, each in its own transaction, recorded in `schema_migrations(version, name, applied_at)`. Expose `migrate(pool)` and a `pnpm db:migrate` script.

- Running twice applies nothing the second time.
- A failing migration rolls back fully and is not recorded; later files don't run.
- Filenames not matching `^\d{4}_[a-z0-9_]+\.sql$` are rejected with a clear error.

### T103 · db: per-test databases

Deps: T102 · Migration: —

`createTestDatabase()` creates a uniquely named database, runs all migrations, returns `{ pool, drop() }`. Use it in every DB integration test from here on.

- Parallel test files don't see each other's data.
- `drop()` removes the database; a test leaving it behind doesn't break later runs.

### T104 · Rooms table

Deps: T102, T105 · Migration: `0001_rooms`

Table per §5 Room schema: `id text pk`, `slug text unique`, `name`, `objective`, `status` (CHECK in `ACTIVE|PAUSED|ARCHIVED|DELETED`, default `ACTIVE`), `owner_id`, `lead_participant_id` (nullable), `settings jsonb default '{}'`, `last_sequence bigint not null default 0`, `created_at timestamptz default now()`, `archived_at`.

- Migration applies cleanly on an empty DB.
- Invalid status is rejected by the database.

### T105 · protocol: prefixed IDs

Deps: T000 · Migration: —

`newId(prefix)` returns `${prefix}_${ulid}`. Define the prefix set as a const union: `room, part, task, dec, mem, msg, inbox, cs, conf, rev, inv, cmd, evt`. Add `isId(value, prefix)`.

- IDs generated in the same millisecond sort in creation order.
- `isId` rejects wrong prefixes and malformed ULIDs.

### T106 · Events table

Deps: T104 · Migration: `0002_events`

Per §19.1: `room_id` FK → rooms, `sequence bigint`, PK `(room_id, sequence)`, `actor_id`, `type`, `schema_version int`, `timestamp timestamptz`, `causation_id`, `payload jsonb`, `payload_hash text`, `redacted boolean default false`.

- Duplicate `(room_id, sequence)` is rejected.

### T107 · protocol: event types

Deps: T105 · Migration: —

`RoomEvent` type and zod schema matching §19.1. Export `EVENT_TYPES` as a const array of every type in the §19.5 catalog and an `EventType` union derived from it.

- Schema rejects unknown event types.
- Every type in §19.5 is present (test compares against a literal list copied from the doc).

### T108 · ledger: append events

Deps: T106, T107, T109 · Migration: —

Create `packages/ledger`. `appendEvents(client, roomId, events[])` inside the caller's transaction: `SELECT … FOR UPDATE` the room row, assign `last_sequence + 1…n`, insert events with `payload_hash = sha256(canonicalJson(payload))`, update `last_sequence`. Returns the stored events.

- 20 concurrent transactions appending to one room produce sequences exactly 1..20 (racing test).
- Appends to different rooms don't block each other.
- Rolled-back transaction leaves no gap.

### T109 · protocol: canonical JSON and hashing

Deps: T000 · Migration: —

`canonicalJson(value)`: keys sorted recursively, no whitespace, rejects `undefined`, functions, non-finite numbers. `sha256Hex(string)`.

- Objects with the same content in different key order serialize identically.
- Known-answer test for the hash.

### T110 · ledger: list events

Deps: T108 · Migration: —

`listEvents(pool, roomId, { after = 0, limit = 100, types? })`; `limit` capped at 500; ascending by sequence; `types` supports exact names and `prefix.*` wildcards.

- Returns only events with `sequence > after`, in order.
- `task.*` matches `task.created` but not `tasks_x`.

### T111 · Room leases

Deps: T104 · Migration: `0003_room_leases`

Per §4.2: table `room_leases(room_id pk, node_id, fencing_token bigint, expires_at)`. Functions `acquireLease(roomId, nodeId, ttlMs = 15000)`, `renewLease`, `releaseLease`. Acquiring an expired lease increments `fencing_token`.

- A second node cannot acquire an unexpired lease.
- Takeover after expiry returns a strictly larger fencing token.
- Renew by a non-holder fails.

### T112 · Fencing on writes

Deps: T108, T111 · Migration: —

`appendEvents` takes the caller's fencing token and verifies it equals the current lease token for the room in the same transaction; otherwise throws `CrossoverError('STALE_FENCE')` (add the code in T114's enum as internal-only).

- A writer holding an old token after takeover is rejected and writes nothing.

### T113 · Idempotency keys

Deps: T104, T114 · Migration: `0004_idempotency_keys`

Table keyed `(participant_id, idempotency_key)` storing a request hash and the response, `created_at`. `withIdempotency(client, participantId, key, requestHash, fn)`: returns the stored response on duplicate; same key with a different request hash → `VALIDATION` error. Expose a purge for rows older than 24 h (§16.2).

- Duplicate call returns the original response without running `fn`.
- Concurrent duplicates: `fn` runs exactly once (racing test).

### T114 · protocol: error model

Deps: T000 · Migration: —

`ErrorCode` union of every code in §16.3, `CrossoverError(code, message, { retryable?, details? })`, `toErrorBody()` producing the §16.3 JSON shape. Map each code to a default `retryable`.

- Serializes exactly to the §16.3 shape.
- `CONFLICT_VERSION`, `RATE_LIMITED` default to retryable; `FORBIDDEN` does not.

### T115 · protocol: command envelope

Deps: T105 · Migration: —

zod schema for the §16.2 envelope: `id` (`cmd_` ID), `method` (`resource.action`), `params` (object), `idempotency_key` (1–128 chars, required for mutating methods).

- Rejects missing `idempotency_key` when the method is marked mutating.

### T116 · Room actor

Deps: T000 · Migration: —

Create `packages/kernel`. `RoomActor` runs submitted async jobs for one room strictly one at a time, in submission order; `RoomActorRegistry` creates actors lazily per room ID.

- Jobs for the same room never overlap (test with deliberate delays).
- Jobs for different rooms run concurrently.
- A failing job rejects its own promise and doesn't stop the queue.

### T117 · Command dispatcher

Deps: T108, T113, T115, T116 · Migration: —

`registerCommand({ method, params: zodSchema, mutating, execute })`. `dispatch(principal, envelope)`: validate params (→ `VALIDATION` with zod issues in details) → run on the room's actor → one transaction wrapping idempotency + `execute` + `appendEvents` with the command id as `causation_id`. Authorization is a hook filled in by T208 (default allow in tests only).

- Unknown method → `NOT_FOUND`.
- If `execute` throws, no events or state persist.
- Events carry `causation_id = envelope.id`.

### T118 · Event publisher

Deps: T117 · Migration: —

`EventPublisher` interface plus an `ioredis` implementation publishing each committed event to `room:{roomId}`. The dispatcher publishes after commit. Publish failures are logged and never fail the command (the table is the outbox, §19.2).

- No publish happens for a rolled-back command.
- Redis down → command still succeeds.

---

## M2 Rooms, participants, auth, policy — S1

### T201 · Participants table

Deps: T104 · Migration: `0005_participants`

Per §6.5: `id`, `room_id`, `kind` (`HUMAN|AGENT`), `display_name`, `authority` (`OWNER|ADMIN|MEMBER`), `role` (`LEAD|DEVELOPER|REVIEWER|OBSERVER`), `status` (`INVITED|ACTIVE|PAUSED|REMOVED`), `agent_manifest jsonb`, `user_id`, `budgets jsonb`, `joined_at`, `last_seen_at`. Partial unique index: one `OWNER` per room. CHECK: `authority IN ('OWNER','ADMIN')` implies `kind = 'HUMAN'` (D8).

- Second owner in a room is rejected.
- Agent with OWNER or ADMIN authority is rejected by the database.

### T202 · `room.create`

Deps: T117, T201 · Migration: —

Creates the room and its creator as `HUMAN` + `OWNER` + `LEAD` (owner leads until a lead is appointed). Emits `room.created`, `participant.joined`. Slug: lowercase, `[a-z0-9-]`, 3–48 chars, unique.

- Duplicate slug → `VALIDATION`.
- Both events are in the ledger at sequences 1 and 2.

### T203 · `room.get_state` (summary)

Deps: T202 · Migration: —

Returns room fields, participants (no secrets), `last_sequence`. Later milestones add sections; design the response as an object of named sections.

- A participant of another room gets `NOT_FOUND` (not `FORBIDDEN`, to avoid leaking existence).

### T204 · Invites

Deps: T202, T208 · Migration: `0006_invites`

`room.invite { role, capability_grants?, expires_in? }` (owner/admin). Returns a one-time token once: 32 random bytes, base64url, prefixed `inv_`. Store only `sha256(token)`, role, grants, `expires_at` (default and max 24 h), `used_at`.

- The plaintext token is never stored or logged.
- Non owner/admin → `FORBIDDEN`.

### T205 · Join with manifest

Deps: T204, T206 · Migration: —

`POST`-style handler `joinRoom(token, manifest)`: validate the §15.2 manifest with zod, consume the token atomically (single use), create an `AGENT` participant with the invite's role, emit `participant.joined`, return access + refresh tokens (T206).

- Reusing a token → `UNAUTHENTICATED`; two concurrent joins with one token: exactly one succeeds.
- Expired token → `UNAUTHENTICATED`.
- `vendor`/`model` stored as self-declared.

### T206 · Access and refresh tokens

Deps: T201 · Migration: `0007_auth_tokens`

Opaque tokens (§15.3): access 1 h (`at_`), refresh 30 d (`rt_`), stored hashed with `family_id`. `issueTokens(participantId)`, `refresh(refreshToken)` rotates; reusing a rotated refresh token revokes the whole family.

- Refresh returns a new pair and invalidates the old refresh token.
- Reuse of an old refresh token revokes every token in the family.

### T207 · Authentication

Deps: T206 · Migration: —

`authenticate(accessToken)` → `Principal { participantId, roomId, kind, authority, role }` or `UNAUTHENTICATED`. Rejects expired, revoked, or tokens of `REMOVED` participants.

- Each rejection case has a test.

### T208 · Policy: `authorize()` and role bundles

Deps: T201, T114 · Migration: —

Create `packages/policy`. `authorize(principal, action, resource, context)` → allow, or throws `FORBIDDEN` with `details.missing_capability`. Encode the §6.1 role bundle table and authority powers (§6.2) as data. Wire it into the dispatcher hook (T117): each command declares its action.

- Table-driven test: every role × every bundle capability.
- Observer cannot mutate anything except presence.

### T209 · Capability strings and scopes

Deps: T208 · Migration: —

Parse `<resource>.<action>[:<scope>]` (§21.1). `capabilityMatches(granted, requested)`: path scopes use glob matching (`workspace.write:src/api/**` covers `src/api/x/y.ts`, not `src/apix.ts`). Define tier per capability (§21.2).

- Parser rejects malformed strings.
- Glob tests including `**`, `*`, and dotfiles.

### T210 · Capability grants and revocations

Deps: T209 · Migration: `0008_capability_grants`

`capabilities.grant { participant_id, capability, expires_at?, requires_approval? }`, `capabilities.revoke`, `capabilities.list`. Effective = role bundle + grants − revocations. Tier 3: owner only, `expires_at` required and ≤ 24 h. Emits `capability.granted` / `capability.revoked`.

- Revocation takes effect on the next command.
- Admin granting Tier 3 → `FORBIDDEN`; Tier 3 without expiry → `VALIDATION`.

### T211 · `participants.set_role` with agent-lead limits

Deps: T208 · Migration: —

Owner/admin may set any role. An agent lead may change only agent roles and never grant what it doesn't hold (§6.3). Emits `participant.role_changed`.

- Agent lead changing a human's role → `FORBIDDEN`.

### T212 · Pause, resume, remove

Deps: T207, T208 · Migration: —

Per §22.1: paused participants get `PARTICIPANT_PAUSED` on every command; remove revokes all tokens (sandbox/task cleanup are hooks for later). A lead cannot pause humans; only a human can un-pause what a human paused.

- Every case in §22.1 and §6.3 relating to pause has a test.

### T213 · Lead appointment and transfer

Deps: T208 · Migration: —

`room.set_lead` (owner/admin), `room.transfer_lead` (current lead → offer), `room.accept_lead` (within 10 min). Emits `lead.transfer_offered`, `lead.changed`. Exactly one lead at all times. (Auto-revert on disconnect comes with presence, later.)

- Accepting after 10 min → `VALIDATION`; lead unchanged.

### T214 · Room lifecycle

Deps: T208 · Migration: —

`room.freeze`, `room.resume`, `room.archive` (owner only) per §5. While `PAUSED`, agent mutations → `ROOM_PAUSED`; humans read; owner can still act. `ARCHIVED` is read-only for everyone.

- State-transition table test for every allowed and disallowed transition.

### T215 · `capability.denied` events

Deps: T208 · Migration: —

Every `FORBIDDEN` from `authorize()` appends `capability.denied { action, resource, missing_capability }` in a separate transaction (the command's own transaction rolls back).

- A denied command leaves exactly one `capability.denied` event and no other change.

### T216 · Platform user accounts — S1

Deps: T202, T701 · Migration: `0017_users`

Minimal platform identity for humans (§15.3): `users(id usr_…, display_name, provider, provider_subject, created_at)` with unique `(provider, provider_subject)`. A development login (`provider = 'dev'`, enabled only by config) issues a user session token; GitHub/Google OAuth plug into the same table later. The gateway resolves the user principal for roomless commands (`room.create`) from it, and `participants.user_id` references `users.id`.

- Dev login is refused unless explicitly enabled.
- `room.create` through the gateway records the creating user as the owner's `user_id`.
- Same provider subject twice resolves to the same user.

---

## M3 Tasks — S1

### T301 · Tasks table

Deps: T201 · Migration: `0009_tasks`

Per §8.1: `tasks` table and `task_reviews(task_id, reviewer_id, verdict, comments, revision, created_at)`. `status` CHECK over §8.2 states; `priority` 0–3; `requirements jsonb` (string array); `dependencies text[]`; `version int`.

- `blocked_reason` required when status is `BLOCKED` (CHECK).

### T302 · `tasks.create` / `tasks.update`

Deps: T301, T208 · Migration: —

Create with `title`, `description`, `requirements[]` (≥ 1), `priority?`, `dependencies?`, `reviewer_id?`, `review_required?` (default from room settings, true). Update takes `expected_version`. Emits `task.created` / `task.updated`.

- Stale `expected_version` → `CONFLICT_VERSION` with the current task in details.
- Unknown dependency ID → `VALIDATION`.

### T303 · `tasks.list` / `tasks.get`

Deps: T302 · Migration: —

Filters: `status[]`, `owner_id`, `mine`. Cursor pagination by `created_at, id`.

- Pagination returns every task exactly once across pages.

### T304 · `tasks.claim` (atomic)

Deps: T302 · Migration: —

Conditional update `WHERE status = 'OPEN' AND version = $v` (§8.3). Emits `task.claimed`.

- 10 concurrent claimants → exactly one wins, the rest get `CONFLICT_VERSION` (racing test).

### T305 · `tasks.assign`

Deps: T304 · Migration: —

Lead/owner/admin assign an OPEN task to a participant. Emits `task.assigned`.

- Developer calling assign → `FORBIDDEN`.

### T306 · `tasks.start` with dependency check

Deps: T304 · Migration: —

Owner of the task only. All dependencies must be `DONE` unless the lead set `override_dependencies` on the task. Emits `task.started`.

- Start with an unfinished dependency → `VALIDATION` naming the dependency.

### T307 · Block / unblock

Deps: T306 · Migration: —

`tasks.block { reason }`, `tasks.unblock` (task owner or lead). Emits `task.blocked` / `task.unblocked`.

- Block without reason → `VALIDATION`.

### T308 · `tasks.submit`

Deps: T306 · Migration: —

`IN_PROGRESS → REVIEW`, or `→ DONE` when `review_required = false`. Emits `task.submitted`.

- Non-owner submit → `FORBIDDEN`.

### T309 · `tasks.review`

Deps: T308 · Migration: —

`approve` → `DONE`, `request_changes` → `IN_PROGRESS`; by reviewer or lead; records a `task_reviews` row. Nobody approves their own task. Health gate: call an injected `HealthGate.isGreenFor(task)` (default always green; T610 wires the real one); lead may pass `override_health`.

- Self-approval → `FORBIDDEN`.
- Gate returning false → `VALIDATION`, unless lead override.

### T310 · Release, reopen, cancel

Deps: T306 · Migration: —

Per the §8.2 table: release (owner/lead) → OPEN, reopen (lead/owner) DONE → IN_PROGRESS, cancel (lead/owner) any non-DONE → CANCELLED. Events for each.

- Cancel on a DONE task → `VALIDATION`.

### T311 · Agent claim leases

Deps: T304 · Migration: —

Agent claims get `lease_expires_at = now + 15 min` (§8.4), renewed by `tasks.heartbeat` and by any command referencing the task. A sweeper (`sweepExpiredLeases(now)`) returns expired, disconnected-agent tasks to OPEN with `task.lease_expired`. Human claims never expire. (Inbox notification to the lead is added in T403.)

- Sweeper ignores human claims and unexpired leases.
- Uses an injectable clock; no real-time sleeps in tests.

### T312 · Task state machine conformance test

Deps: T305–T311 · Migration: —

One table-driven test listing every (state, command, actor role) from §8.2 with the expected outcome.

- Covers every row of the §8.2 transition table plus at least one forbidden case per state.

---

## M4 Messages, inbox, decisions, memory

### T401 · Messages — S1

Deps: T208 · Migration: `0010_messages`

`messages.send { body, mentions[], refs[], reply_to? }`, `messages.list { before?, after?, limit }`, `messages.edit` (author only; original stays in the ledger). Mentions are explicit IDs only; never parse `@names` (§17.5). Body ≤ 32 KB.

- Mentioning a non-participant → `VALIDATION`.
- Editing someone else's message → `FORBIDDEN`.

### T402 · Inbox — S1

Deps: T201 · Migration: `0011_inbox_items`

Internal `deliverInbox(client, participantId, { kind, ref, summary })`; commands `inbox.list { unacked_only }`, `inbox.ack { ids[] }`. Kinds per §17.2.

- Ack is idempotent; acking another participant's item → `NOT_FOUND`.

### T403 · Inbox producers — S1

Deps: T401, T402, T305, T309, T311 · Migration: —

Deliver inbox items for: mentions, task assignment, review requested (on submit, to reviewer or lead), lease expired (to lead).

- Each producer has a test asserting the exact recipient.

### T404 · Decisions: propose and positions — S1

Deps: T208 · Migration: `0012_decisions`

Per §7.1–7.2: `decisions.propose { title, context, options[≥2], decide_by? }`, `decisions.add_position { option_id, argument }` (one position per participant; re-adding replaces it). Emits `decision.proposed` / `decision.position_added`.

- Position on a non-PROPOSED decision → `VALIDATION`.

### T405 · Decisions: decide and withdraw — S1

Deps: T404 · Migration: —

`decisions.decide { outcome_option_id | reject, rationale }` (lead only, rationale required), `decisions.withdraw` (proposer, while PROPOSED). Uses `expected_version`.

- Non-lead decide → `FORBIDDEN`.

### T406 · Decisions: veto and supersede — S1

Deps: T405 · Migration: —

`decisions.veto { rationale }` by the owner within 24 h of decision → `VETOED`. Accepting a decision with `supersedes` moves the old one to `SUPERSEDED`.

- Veto after 24 h → `VALIDATION`; agent veto → `FORBIDDEN`.

### T407 · Decision → memory mirror — S1

Deps: T405, T408 · Migration: —

On ACCEPTED, write memory `decisions/<id>` (system actor) in the same transaction (§7.4). On VETOED or SUPERSEDED, update the entry's status.

- Participants can't write under `decisions/*`.

### T408 · Memory: put with compare-and-set — S1

Deps: T208 · Migration: `0013_memory`

Tables `memory_entries` and `memory_revisions` (§18.1). `memory.put { key, value, content_type, expected_revision, source_refs? }`; `expected_revision = 0` creates. Value ≤ 64 KB. Emits `memory.updated`.

- Concurrent puts with the same expected revision → exactly one wins (racing test).

### T409 · Memory: read, history, delete, namespaces — S1

Deps: T408 · Migration: —

`memory.get`, `memory.list { prefix }`, `memory.history`, `memory.delete { expected_revision }` (tombstone). Namespace rules §18.3.

- Writing `agents/<other-id>/x` → `FORBIDDEN`.
- History returns every revision including the tombstone.

### T410 · `room.digest` — S1

Deps: T403, T110 · Migration: —

Deterministic summary since a sequence (§17.3) from the ledger alone: counts per type, task changes, decisions, memory keys changed. (Workspace sections are added in M5/M6.)

- Same ledger range → byte-identical output.

### T411 · Loop protection — S1

Deps: T401 · Migration: —

Per §17.6: > 20 consecutive agent messages with no non-message mutation in between → those agents throttled to 1 message/min (`RATE_LIMITED`), `loop.detected` event, inbox items for lead and owner. Any non-message mutation resets.

- Counter reset by a task update is tested.

### T412 · Provenance labels — S1

Deps: T401, T409 · Migration: —

Every message, memory entry, decision position and task description returned by read commands carries `provenance { author_id, author_kind, trust }` (§16.5).

- A shared serializer is used by every read command (test asserts presence on each).

---

## M5 Workspace engine — S2

### T501 · Git command wrapper

Deps: T000 · Migration: —

Create `packages/workspace`. `git(args, { cwd, gitDir, input?, timeoutMs, env? })` via `execFile` (never a shell). Typed `GitError` with exit code and stderr. `assertGitVersion()` requires ≥ 2.38 (D1).

- Timeout kills the process and throws.
- Version check rejects 2.37.

### T502 · Room repository init

Deps: T501 · Migration: —

`initRoomRepo(workspaceRoot, roomId)` creates `<root>/<roomId>.git` (bare) with an empty initial commit on `refs/room/canonical`. Idempotent.

- Calling twice is a no-op; the ref points at the same commit.

### T503 · Materialize operations into a commit

Deps: T502 · Migration: —

`materialize(repo, baseCommit, operations[])` → commit SHA, using a temporary index file (`GIT_INDEX_FILE`), never a worktree. Supports `create`, `modify` (full content), `delete`, `rename` (§10.1).

- Create of an existing path, modify/delete of a missing path → typed validation error.
- Temp index is cleaned up on success and failure.

### T504 · Modify via unified diff

Deps: T503 · Migration: —

`modify` with `patch` applies with `git apply --cached` against the temp index.

- A patch that doesn't apply → typed validation error naming the path.

### T505 · Path validation

Deps: T000 · Migration: —

`normalizePath(p)`: POSIX, NFC, no leading `/`, no `..` segments, no `.git` segment, no NUL, ≤ 4096 bytes.

- Table test covering every rejection rule.

### T506 · Ignore rules

Deps: T503 · Migration: —

Honor `.gitignore` files in the tree and a root `.roomignore` (§9.3). Operations on ignored paths are rejected.

- Nested `.gitignore` negation (`!keep.log`) is respected.

### T507 · Merge

Deps: T503 · Migration: —

`merge(repo, base, head, candidate)`: if `base === head` fast-forward; else `git merge-tree --write-tree --merge-base=<base> <head> <candidate>`. Returns `{ clean: true, tree }` or `{ clean: false, conflicts }` with raw per-file info.

- Non-overlapping edits to one file merge cleanly.
- Same-line edits report a conflict.

### T508 · Conflict classification and hunks

Deps: T507 · Migration: —

Map merge results to §11.1 kinds: `CONTENT`, `MODIFY_DELETE`, `RENAME`, `ADD_ADD`, `BINARY`, with hunks `{ base, ours, theirs, line ranges }` for content conflicts.

- One fixture test per kind.

### T509 · Adjacent-hunk rule

Deps: T508 · Migration: —

§10.4 counts directly adjacent changes as conflicts. Verify Git's behavior with tests; if any case differs, add a post-check that enforces the rule.

- Test: edits on line 10 and line 11 by different sides → conflict. Edits on lines 10 and 12 → clean.

### T510 · Binary and large files

Deps: T507 · Migration: —

Files > 5 MB or detected binary (NUL in first 8 KB) are binary; any concurrent modification of a binary path is a conflict. (S3 pointer storage is deferred; reject > 25 MB for now.)

- Concurrent binary edits → `BINARY` conflict even if bytes are identical regions.

### T511 · Workspace tables

Deps: T104 · Migration: `0014_workspace`

`workspaces(id, room_id, repo_path)`, `workspace_revisions(workspace_id, revision, commit_sha, changeset_id, created_at)`, `file_revisions(workspace_id, path, revision, workspace_revision, blob_sha, actor_id)`, `changesets` per §10.1 with `payload jsonb` and `status`.

- `(workspace_id, revision)` and `(workspace_id, path, revision)` unique.

### T512 · Apply pipeline

Deps: T117, T503–T511 · Migration: —

`workspace.apply_changeset` command implementing §10.3 steps 1–6, 8, 9 on the room actor: authorize per path, validate, persist payload (status PENDING), materialize, merge, classify, commit. Idempotent by key.

- Atomic: one conflicting file → nothing applied, status `CONFLICT`.
- Resubmission with the same key returns the original result.
- Emits `workspace.changeset.applied` with `applied_revision`.

### T513 · Commit ordering and reconciliation

Deps: T512 · Migration: —

Order per §19.4: write objects → PostgreSQL txn → update ref. `reconcileRef(workspace)` sets the ref to the latest `workspace_revisions` commit; run on startup.

- Simulated crash between txn and ref update → reconcile fixes the ref.

### T514 · `workspace.list` / `workspace.read`

Deps: T512 · Migration: —

Read at head or a given revision; `read` returns content, `file_revision`, `workspace_revision`.

- Reading at an old revision returns the old content.

### T515 · `workspace.diff` / `workspace.history`

Deps: T512 · Migration: —

Unified diff between two workspace revisions (optional `paths`); history of the workspace or a path with `limit`/`before`. No Git SHAs in responses (§9.1).

- Responses contain revisions only, never SHAs (test greps the output).

### T516 · `workspace.blame`

Deps: T512 · Migration: —

Per-line `{ workspace_revision, actor_id }` for a path at a revision.

- Lines changed by two actors attribute correctly.

### T517 · `workspace.search`

Deps: T512 · Migration: —

Maintain a checked-out tree of head (updated after each commit); search with ripgrep (`rg --json`), optional glob (§9.5).

- Search sees a change immediately after it's applied.

### T518 · ChangeSet limits

Deps: T512 · Migration: —

≤ 500 operations, ≤ 25 MB of text per ChangeSet (§10.1) → `VALIDATION`.

- Boundary tests at exactly the limits.

### T519 · Merge benchmark

Deps: T512 · Migration: —

`pnpm --filter @crossover/workspace bench`: 200 non-fast-forward applies of 20-file ChangeSets; reports p50/p95. Target p95 < 50 ms (§3).

- Script runs in CI as a non-blocking job; result posted in the PR.

### T520 · Parse check

Deps: T512 · Migration: —

§10.3 step 7 with tree-sitter for TypeScript, JavaScript and Python: merged file fails to parse while neither side did → treat as conflict. `source = EDITOR` drafts that already fail are let through.

- Fixture: two clean-merging edits that produce invalid syntax → conflict; skip a file over 1 MiB
  and stop after 8 MiB of unique source has been parsed in one apply.

---

## M6 Conflicts and health — S2

### T601 · Conflicts table and creation

Deps: T512 · Migration: `0015_conflicts`

Per §11.1. A `CONFLICT` result creates a conflict with `counterparty_changesets` (applied ChangeSets between base and head touching the conflicting paths). Emits `workspace.conflict.created`.

- Counterparties include only ChangeSets that touched conflicting paths.

### T602 · `conflicts.list` / `conflicts.get`

Deps: T601 · Migration: —

- Room-scoped, cursor-paginated listing with optional status and submitter filters; lookup by conflict ID.
- Each viewer is authorized for every conflict path and every path in its merge messages. Redact a conflict entry to `{ path: null, kind, reason: "unauthorized" }` if any of its paths is denied; omit counterparty IDs if any entry is redacted.

### T603 · Resolution

Deps: T601 · Migration: —

`workspace.apply_changeset` with `conflict_id` (source `RESOLUTION`). Success → conflict `RESOLVED`, original ChangeSet superseded. Another conflict → same conflict stays open, `attempts++`.

- Only the submitter, lead or owner may resolve.

### T604 · Escalation

Deps: T603, T402 · Migration: —

To lead after 2 failed attempts, after 10 min for agent submitters (sweeper with injectable clock), or on `conflicts.escalate`. Inbox item to the lead. Lead is the submitter → owner.

- Each trigger tested.

### T605 · Abandon

Deps: T601 · Migration: —

`conflicts.abandon` (submitter, lead, owner): ChangeSet `REJECTED`, conflict `ABANDONED`.

### T606 · Edit intents

Deps: T207 · Migration: —

`presence.set_intent { paths, ranges?, task_id? }` replaces the caller's room-scoped Redis intent (45 s TTL); paths are normalized/deduped, optional `{ path, start_line, end_line }` ranges are 1-based inclusive and must reference a listed path, and `task_id` must exist in the room. `presence.clear_intent {}` deletes it. `presence.list_intents {}` returns active `{ participant_id, paths, ranges, task_id, expires_at }` rows sorted by participant. None are ledger events (§11.4, §13.4, §19.3).

- Intent expires without heartbeat.

### T607 · Health runner

Deps: T512 · Migration: `0016_health_runs`

Room settings `health_command` and `health_image` (default `node:22-bookworm-slim`; image must be in operator allowlist `HEALTH_IMAGES`). `HealthRunner` interface; first implementation runs the command in a Docker container (no network, non-root, read-only checkout) on the target revision with CPU/memory limits and a 10-minute timeout. Store runs with status `GREEN|RED|ERROR`, duration, log.

- Exit 0 → GREEN, non-zero → RED, timeout/docker failure → ERROR.

### T608 · Coalescing queue

Deps: T607 · Migration: —

At most one run in progress and one queued; the queued run always targets the latest head (§12.1).

- 10 rapid ChangeSets produce ≤ 2 runs, the last on the final head.

### T609 · Health events and suspects

Deps: T608, T402 · Migration: —

Emit `workspace.health`. On RED, include the last GREEN revision and send inbox items to authors of ChangeSets in that range.

- Suspect authors computed from the exact revision range.

### T610 · Health gate for task review

Deps: T609, T309 · Migration: —

Implement `HealthGate` for T309: GREEN at a revision including the task's artifacts.

- Approval blocked while RED, allowed once GREEN.

### T611 · Health dependency cache — S2

Deps: T607, T1007 · Migration: —

Added in Review 4. Health runs have no network (T607), so a project's dependencies can't be installed in the run itself. Each room gets a dependency-cache volume. A separate **install step** fills it: the room setting `health_install_command`, e.g. `npm ci`, runs in the same image with egress only through the T1007 allowlist proxy (package registries), whenever the lockfile at the target revision differs from the one the cache was built from. Health runs mount the cache read-only, with no network.

- The cache key is the lockfile hash (configurable path list, default `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`, `go.sum`); an unchanged lockfile means no install.
- An install failure records the health run as `ERROR` with the install log, never as `RED`.
- Tests: a non-allowlisted host is refused during install; the health run itself still has no network; a changed lockfile triggers exactly one reinstall.

---

## M7 Gateway, MCP, end-to-end

### T701 · REST commands — S1

Deps: T117, T207 · Migration: —

Create `packages/gateway` (Fastify). `POST /v1/rooms/:roomId/commands` takes the envelope; bearer auth; maps `ErrorCode` → HTTP status (`UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `VALIDATION` 400, `CONFLICT_*` 409, `RATE_LIMITED`/`BUDGET_EXCEEDED` 429, `APPROVAL_REQUIRED` 202). `POST /v1/rooms/:roomId/join`.

- Error body is exactly the §16.3 shape.

### T702 · REST reads — S1

Deps: T701 · Migration: —

`GET /v1/rooms/:roomId/events?after&limit&types`, `GET /v1/rooms/:roomId/state`.

- Room ID in path must match the token's room.

### T703 · WebSocket — S1

Deps: T701, T118 · Migration: —

`hello { protocol_version, client, client_version }` negotiation (§16.4); command frames with identical semantics to REST; `subscribe { after }` streams events in order, backfilling from PostgreSQL on gaps (§19.2, §20).

- Client that misses a Redis message still receives every event in order.

### T704 · Filtered subscriptions — S1

Deps: T703 · Migration: —

Profiles `relevant` (default for agents), `all`, `custom` per §17.1.

- `relevant` delivers a task assignment to the assignee and not to an unrelated agent.

### T705 · Backpressure — S1

Deps: T703 · Migration: —

Per-connection buffer limit (1,000 events or 5 MB) → close with `resync_required` (§20).

### T706 · Wake webhooks — S1

Deps: T402, T205 · Migration: —

POST to the manifest's `wake_webhook_url` on new inbox items, HMAC-SHA256 signed, at most one per agent per 30 s with batching (§17.4).

- Signature verifiable with a documented algorithm; rate limit tested with a fake clock.

### T707 · MCP server skeleton — S1

Deps: T701 · Migration: —

Create `packages/mcp` with `@modelcontextprotocol/sdk`, Streamable HTTP transport, authenticating with the room access token. Calls go through the same dispatcher.

- `tools/list` works for an authenticated agent; unauthenticated → 401.

### T708 · MCP task tools — S1

Deps: T707, T312 · Migration: —

Tools wrapping every `tasks.*` command, with JSON schemas derived from the zod schemas (no hand-copied schemas).

### T709 · MCP collaboration tools — S1

Deps: T707, T403, T409, T406 · Migration: —

Messages, inbox, memory, decisions, digest.

### T710 · MCP workspace tools — S2

Deps: T707, T517 · Migration: —

`read_file`, `list_dir`, `grep`, `diff`, `apply_changeset` against the canonical workspace (the sandbox-backed coding tools come with the sandbox milestone).

### T711 · MCP provenance framing — S2

Deps: T709, T412 · Migration: —

Participant and external content returned by MCP tools is wrapped in labeled, delimited blocks (§23.2).

- Snapshot test of a framed message.

### T712 · Server composition and end-to-end test — O1

Deps: T702–T711 · Migration: —

`apps/server` wiring all modules; e2e test: create room → invite → agent joins via MCP → lead creates task → agent claims, applies a ChangeSet, submits → lead approves.

- Runs in CI against docker services.

### T713 · Background lease renewal — S1

Deps: T117, T701 · Migration: —

A per-node loop that renews every lease in `RoomLeases.heldRooms()` at a third of the TTL, so a room with open WebSocket subscribers but no recent commands keeps its owner. On `STALE_FENCE` the room is forgotten and its actor drained; on shutdown `releaseAll()` runs. Add an `onAcquire(roomId)` option to `RoomLeases`, run on the room's actor before the first command after any acquisition; T712 wires workspace `reconcileRef` into it (§19.4, §26).

- With a fake clock, an idle held room is renewed before expiry and keeps its fencing token.
- A room taken over by another node is dropped from `heldRooms()` on the next tick.
- Shutdown releases all leases; another node acquires immediately.
- `onAcquire` runs exactly once per acquisition (including re-acquire after expiry), before the first command; a throwing hook fails that command and leaves the room unacquired.

---

## M8 Git interoperability (§24) — S1

### T801 · `git.import` — S1

Deps: T202, T512 · Migration: `0018_upstream`

`git.import { url, branch }` (owner/lead) clones into the room repository through an injected `GitCredentialProvider` (public HTTPS repos work with none; the GitHub App provider arrives with the plugin runner). Records `upstream { url, branch, last_synced_sha, last_synced_room_revision }` and writes the imported tree as workspace revision 1 with `source = UPSTREAM`, actor `system:upstream`.

- Import of a fixture repo produces revision 1 whose tree equals the upstream branch tip.
- Importing into a room whose workspace already has revisions beyond 0 → `VALIDATION`.
- No credential ever appears in events, responses or logs.

### T802 · Health command suggestion — S1

Deps: T801 · Migration: —

After import, suggest a `health_command` (§24.1) from `package.json` scripts (`typecheck`, `test`), `Makefile` targets or `pyproject.toml`, returned in the import response; never applied automatically.

- Fixture repos for each ecosystem produce the expected suggestion; a repo with none yields `null`.

### T803 · `git.pull_upstream` — S1

Deps: T801 · Migration: —

Fetch the upstream branch, diff `last_synced_sha → new tip`, and submit it as an `UPSTREAM` ChangeSet based on `last_synced_room_revision` through the normal apply pipeline (§24.2). Conflicts follow the normal flow with the lead as submitter of record.

- Non-overlapping upstream and room edits merge; overlapping ones create a conflict.
- `upstream.last_synced_*` advance only when the ChangeSet applies.

### T804 · Checkpoints — S1

Deps: T512, T609 · Migration: `0019_checkpoints`

`checkpoints.create { message }` (lead/owner) marks the current workspace revision; requires health GREEN unless the owner overrides (§24.3). `checkpoints.list`. Emits `checkpoint.created`.

- RED health blocks creation without override.

### T805 · Checkpoint export — S1

Deps: T804, T801 · Migration: —

`checkpoints.export { mode: squashed | per_changeset }` builds commits on `room/<slug>` (never the default or protected branch) with the checkpoint creator as author and `Co-authored-by:` trailers for every contributing participant (§24.3); pushes through the credential provider. Emits `checkpoint.exported`.

- Squashed export: one commit per checkpoint with the right tree and trailers.
- Push target outside `room/*` is refused.

### T806 · Pull request on export — S1

Deps: T805 · Migration: —

After export, open a pull request through a `PullRequestProvider` interface (Tier 2 `github.create_pull_request`); a fake provider in tests, the GitHub implementation with the plugin runner.

- Export with PR returns the provider's PR URL; without the capability → `FORBIDDEN`.

---

## M9 Safety controls (§22–23)

### T901 · Secret scanning on ChangeSets — S2

Deps: T512 · Migration: —

Gitleaks-compatible rule subset (AWS keys, GitHub tokens, private key blocks, generic high-entropy assignments) run in apply step 2 (§10.3, §23.3). High confidence → `VALIDATION` naming file and line; low confidence → applied but flagged to author and owner via inbox.

- Fixtures for each rule; no plaintext secret is echoed back in errors or events.

### T902 · Secret scanning on messages and memory — S1

Deps: T901, T401, T408 · Migration: —

Same scanner on `messages.send/edit` and `memory.put`.

- A message containing a private key block is rejected; a low-confidence match is flagged.

### T903 · Circuit breakers — S2

Deps: T512, T402 · Migration: `0021_changeset_held` (adds `HELD` to the status CHECK)

Hold a ChangeSet (`CIRCUIT_BREAKER`, status `HELD`) that deletes > 50 files or > 30% of lines, touches protected patterns (default `.github/workflows/**`, `**/*.pem`, `**/.env*`, `infra/prod/**`), or comes from an agent with > 5 rejected/abandoned ChangeSets in 30 min (§22.4). Lead/owner approve or reject via inbox.

- Each trigger tested; an approved held ChangeSet then applies through the normal pipeline.

### T904 · Budgets and rate limits — S1

Deps: T117 · Migration: —

Per-participant budgets (§22.3: 120 commands/min, 10 messages/min, 60 ChangeSets/h, 100 tool invocations/h) in Redis, enforced in the dispatcher before the transaction. `BUDGET_EXCEEDED` with `retry_after`; `budget.exceeded` event. Owner overrides per room/participant from `settings`/`budgets`.

- Fake clock; the window resets; Redis down → fail open with a logged warning (commands keep working).

### T905 · Approval gates — S1

Deps: T210, T402 · Migration: `0020_approvals`

Grants with `requires_approval` make invocations return `APPROVAL_REQUIRED` with an approval id; `approvals.list`, `approvals.decide` (owner/lead); approved actions execute; approvals expire after 24 h (§22.2).

- Approve executes exactly once (idempotent); reject and expiry never execute.

### T906 · Event redaction — S1

Deps: T208 · Migration: —

`events.redact { sequence, reason }` (owner only) replaces the payload with a tombstone, sets `redacted`, keeps `payload_hash`, and appends `event.redacted` (§19.6).

- Redacted payload is gone from reads and digests; hash unchanged; non-owner → `FORBIDDEN`.

---

## M10 Execution sandboxes (§14) — S2

Added in Review 3. The first driver is local Docker with the gVisor runtime when available. The `ExecutionDriver` interface keeps dedicated sandbox hosts a later swap. Log storage sits behind an interface (local disk first, S3 later).

### T1001 · Execution service and sandbox lifecycle — S2

Deps: T512, T207 · Migration: `0022_sandboxes`

`ExecutionDriver` interface plus a Docker driver. One sandbox per participant, created lazily on first `sandbox.*` call. Limits from §14.6: CPU, memory and disk; hibernate after 30 min idle (container stopped, volume kept; background processes killed); volume removed when the participant leaves or the room is archived. A `sandboxes` row tracks status, `base_revision` and the volume ref.

- Lazy creation, hibernate and resume, and cleanup on leave and archive are each tested with a fake driver. One Docker-backed smoke test is skipped when Docker is unavailable.
- Two participants never share a sandbox, and one can't address the other's.

### T1002 · Materialize the canonical workspace — S2

Deps: T1001, T514 · Migration: —

Internal read-only Git endpoint on the workspace node, authenticated with a sandbox-scoped read token (room, participant, expiry; never valid on the public API). The sandbox fetches the canonical head into an ordinary clone, and `base_revision` is set. Per-room reference repository so new sandboxes fetch only missing objects (§14.3).

- The token can't read another room or call any command. Paths outside the participant's read scope are not materialized (T521 rules).

### T1003 · Working-copy status — S2

Deps: T1002 · Migration: —

`sandbox.status` → `{ base_revision, head_revision, behind_by, modified, added, deleted }`, computed with `git status` inside the sandbox. Ignored and generated files are never reported or submitted.

- Fixtures for modified, new, deleted, ignored and renamed files.

### T1004 · Staying current: behind, auto-sync, `sandbox.sync` — S2

Deps: T1003 · Migration: —

When canonical advances, the owner gets `sandbox.behind { behind_by, changed_paths, overlaps_local_changes, intents }`, filtered to paths the owner may read. Auto-sync (fast-forward plus `sandbox.synced`) runs only when no process is running and no changed path overlaps a local modification. Human sandboxes always follow head. `sandbox.sync` stashes local changes as a temporary commit, fetches and rebases. Clean → `{ synced_to }`; conflicts leave markers and return the conflicted paths (§14.4).

- Never changes files under a running process. Each overlap case and the conflict-marker case are tested.

### T1005 · `changes.submit` — S2

Deps: T1003 · Migration: —

`changes.submit { paths?, message, task_id? }` diffs `base_revision` against the working tree (tracked plus new non-ignored files, optional path filter), packages a ChangeSet with `source = SANDBOX`, and runs the apply pipeline (§10). APPLIED → the base fast-forwards. CONFLICT → the Conflict is returned (§14.5).

- Same per-path authorization as `workspace.apply_changeset` (a scoped agent can't submit outside scope). Binary and symlink files round-trip.

### T1006 · `sandbox.exec` and output — S2

Deps: T1001, T703 · Migration: —

`sandbox.exec { command, cwd?, timeout_s? }`: 10 min default timeout (owner may raise it to 60); background processes allowed. stdout and stderr stream on a dedicated `sandbox.output` WebSocket channel, never the ledger. Output is stored as chunked log objects behind a `LogStore` interface (30-day retention). The ledger records only `sandbox.exec.started` and `sandbox.exec.finished { exit_code, duration_ms, log_ref }` (§14.8).

- Timeout kills the process tree. Output is visible only to the sandbox owner, lead, owner and admins. The ledger events carry no output.

### T1007 · Isolation and egress — S2

Deps: T1001 · Migration: —

gVisor (`runsc`) runtime when configured. Default-deny network egress except through an allowlist proxy: package registries, GitHub read-only, and per-room owner additions. Cloud metadata endpoints (IMDS) are blocked. No platform or plugin credentials in the sandbox environment or filesystem (§14.7, §21.4).

- Tests: a non-allowlisted host and IMDS are refused; an allowlisted registry works; the sandbox environment contains no platform secrets.

### T1008 · MCP coding tools — S2

Deps: T1004, T1005, T1006, T707 · Migration: —

`sandbox.status`, `sandbox.sync`, `sandbox.exec`, `changes.submit` and file read/write inside the working copy, as MCP tools with the same authorization as their commands.

- An agent can go through status → edit → exec tests → submit → handle a conflict via `sandbox.sync`, end to end through MCP.

---

## M11 Clients (§27, §29) — S1

Added in Review 3. Every client goes through the public REST and WebSocket API only.

### T1101 · TypeScript SDK — S1

Deps: T702, T703 · Migration: —

`@crossover/sdk`: typed command calls generated from the protocol catalog, REST and WebSocket transports, `subscribe({ after })` with automatic reconnect from the last seen sequence (handles `resync_required`), and idempotency keys.

- Contract tests against a real `apps/server`. A reconnect after a dropped socket loses no event and duplicates none.

### T1102 · CLI (`room`, Go) — S1

Deps: T702, T703 · Migration: —

A single static Go binary per D12 and §15.4: login and join, tasks, events tail with reconnect from the last sequence, workspace read and apply. It talks to the public REST and WebSocket API directly, against T1101's contract test fixtures.

- Golden-output tests for each command; exit codes follow the §16.3 error categories. Cross-compiled release builds for linux, darwin and windows in CI.

### T1103 · Python SDK — S1

Deps: T1101 · Migration: —

The same surface as T1101, typed from the same catalog.

- Shares T1101's contract test fixtures.

### T1104 · Web app shell — S1

Deps: T1101, T216, T217 · Migration: —

Login, room list and create, room view with participants, tasks board, Activity feed (live via WebSocket, including `capability.denied` as redacted for the viewer), pause/resume controls.

- Covers §30 steps 1, 3–4, 6, 14 and 15 in a browser test.

### T1105 · Workspace editor, drafts and merge view — S1

Deps: T1104, T606 · Migration: —

Editor with live intents, draft flush, live cursors and merge view (§27; demo steps 7, 9 and 10). To be broken down into smaller tasks once T1104 lands.

---

## M12 Plugins (§21.4–21.5) — S2

Added in Review 4. Plugins run server-side and agents never receive credentials (§21.4, D10). The first plugins are the §29 MVP set: GitHub, Browser and AWS (read plus staging deploy). The runner reuses M10's container isolation and egress proxy.

### T1201 · Tool registry, `tools.list` and `tools.invoke` — S2

Deps: T208, T215 · Migration: —

A plugin declares tools as `{ name, capability, tier, input schema }`. `tools.list` returns the tools the caller holds the capability for. `tools.invoke { tool, args, idempotency_key }` authorizes `<capability>:<scope>`, with the scope derived from the args by the tool (e.g. `org/repo`, a function ARN), and runs it through the runner. Tier 2 and 3 invocations log `tool.invoked`; denials log `capability.denied` (T215). Results that contain outside content are labeled `trust: external`.

- A tool whose capability isn't held → `FORBIDDEN`; a scope outside the grant → `FORBIDDEN` naming the capability; tier 3 is never in a role bundle.
- A non-idempotent tool is never retried by the platform (§26); a provider outage → a retryable error code.

### T1202 · Plugin runner isolation — S2

Deps: T1201, T1007 · Migration: —

Each invocation runs in a short-lived container or child process with a timeout, CPU and memory limits, egress only to that plugin's declared hosts (through the T1007 proxy), and no ambient credentials or environment. Output is size-bounded.

- Tests: an undeclared host is refused; a hung invocation is killed at its timeout; the environment holds only the per-invocation credential.

### T1203 · Integrations and credential broker — S2

Deps: T1201 · Migration: `0023_integrations`

The owner connects an integration per room (GitHub App installation, AWS role ARN plus external ID, OAuth token). Long-lived secrets are stored encrypted behind a `SecretStore` interface: envelope encryption with a per-room data key, a KMS-backed implementation for production and a config-keyed one for development. Per invocation the broker mints a short-lived credential (an STS session ≤ 15 min, a GitHub installation token ≤ 1 h) and hands it only to the runner.

- No secret or minted credential ever appears in a response, event, log or `tool.invoked` payload (a test scans them all for each).
- Only the owner can connect or disconnect an integration.

### T1204 · GitHub plugin — S2

Deps: T1202, T1203 · Migration: —

`github.read_repository` (tier 0), `github.create_pull_request:org/repo` (tier 2), using the room's GitHub App installation token. Shared with M8's PR-on-export (T806) so there is one GitHub client.

- Contract tests against a recorded GitHub API, plus scope enforcement per repository.

### T1205 · Browser plugin — S2

Deps: T1202 · Migration: —

`browser.navigate` / `browser.read_page` in a sandboxed headless browser (tier 2), egress through the proxy allowlist plus room-added domains. It returns text and an optional screenshot reference, labeled `trust: external`.

- Cloud metadata and private address ranges are unreachable; page content never runs in the platform process.

### T1206 · AWS plugin — S2

Deps: T1202, T1203 · Migration: —

`aws.read_logs:<arn>` (tier 0) and `aws.deploy_lambda:<function>` (tier 2 for `staging-*`, tier 3 for anything else, owner-granted with ≤ 24 h expiry, §21.2), via STS assume-role with the external ID.

- The demo step 14 path: `aws.deploy_lambda:prod-api` without a tier 3 grant → `FORBIDDEN` and `capability.denied` visible in Activity.

---

## M13 Lessons from building (§34) — S1

Added after Review 4, when Peter selected the first §34 proposals. T1301 comes first, before T709, so the MCP collaboration tools are covered by the conformance test from the start.

### T1301 · Egress visibility conformance test — S1

Deps: T702, T703 · Migration: —

§34.5's rule, enforced. Every read command and stream declares how it applies the participant view. `CommandDefinition` gains `view: "participant" | "own" | "none"`:

- `participant`: the output goes through a kernel participant-view function (`redactEventFor` or a per-record redactor).
- `own`: the caller's own records only.
- `none`: no data from other participants. A one-line `view_reason` is required.

The declaration is required for every non-mutating command and checked at `registerCommand`. MCP tools and the WebSocket `subscribe` frame declare the same.

The conformance test composes the real server and seeds a `capability.denied` event with a denied path for participant A. It enumerates every registered read surface: REST commands, WebSocket `subscribe` backfill and live, the digest, and MCP tools. For each surface that returns events or paths, it reads as participant B and asserts the path is absent.

- A read command registered without a `view` declaration fails at startup.
- The test fails if a new surface returns A's denied path to B. Sabotage check: remove `redactEventFor` from one surface and the test names that surface.
- New surfaces (T709, T710, M8 exports, T903 webhooks) are picked up automatically, without editing the test.

### T1302 · Evidence on submit — S1

Deps: T308, T309 · Migration: `0024_task_evidence`

§34.3. `tasks.submit` accepts optional `evidence`:

```text
evidence: [{
  requirement,               index into the task's requirements
  proof: [{ kind: test | check | manual, ref, note? }],     1..10
  sabotage?: [{ broke, failed }]                            0..10
}]
```

Each requirement appears at most once, and the total size is capped at 32 KiB. The latest submission's evidence is stored on the task (`tasks.evidence jsonb`) and carried in `task.submitted`. Task views return `evidence` plus `missing_evidence` (the requirement indices without proof). The reviewer's `REVIEW_REQUESTED` inbox summary says how many requirements lack evidence. A room setting `require_evidence` (default false) makes a submit with missing evidence a `VALIDATION` error, naming the indices.

- An out-of-range or duplicate requirement index → `VALIDATION`.
- A resubmit after `request_changes` replaces the evidence; earlier evidence stays in the `task.submitted` history.
- `require_evidence` on: a submit missing evidence for one requirement → `VALIDATION` with `details.missing_evidence`. Off: accepted, and flagged in the view.

### T1303 · `participant.manifest_changed` — S1

Deps: T205, T707 · Migration: —

§34.6. An agent's manifest can change after it joins:

- through `participants.update_manifest { manifest }`, which is self-only, agents only, and validated like the join manifest;
- through the MCP gateway, when `initialize`'s `clientInfo` name or version differs from the stored `client`/`client_version`. The gateway applies that update as `system` via `runSystem`.

When `vendor`, `model`, `client` or `client_version` changes, the platform stores the new manifest. It emits `participant.manifest_changed { participant_id, changes: { field: { before, after } } }` and sends a `MANIFEST_CHANGED` inbox item to the lead and owner. A changed `wake_webhook_url` is reported only as `wake_webhook_url_changed: true`, never the URL. An identical manifest is a no-op with no event.

- Updating another participant's manifest → `FORBIDDEN`; a human participant → `VALIDATION`.
- An MCP reconnect with a new `clientInfo.version` produces exactly one event and one inbox item each for the lead and owner; reconnecting again with the same version produces none.
- The event payload never contains the webhook URL (a test scans the payload).
- `participants.update_manifest` joins the §16.1 catalog (mutating) and `participant.manifest_changed` the §16.2 event types, both documented in the same PR.
