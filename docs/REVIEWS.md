# Lead reviews

Periodic big-picture reviews by O1: is the merged code building the product in ARCHITECTURE.md, in the right order? Newest first.

## 2026-10-07 · Review 3 (66 of 114 backlog tasks merged, 17 since Review 2)

**State.**

- **Since Review 2:**
  - lifecycle and denial events (T214, T215);
  - tasks through block/unblock (T301–T307);
  - the workspace benchmark and its hot-spot fixes (T519, T522, T523);
  - per-path read scoping (T521) and conflict creation (T601);
  - the MCP skeleton and workspace tools (T707, T710);
  - REST reads (T702).
- **Milestones:** M1, M2 and M5 (bar T520) are complete. M3 is at 7/12, and T308–T312 are in an approved PR chain landing one PR at a time. M6 is at 1/10, with T602 in review. M7 is at 5/13, with T703 in review. M4, M8 and M9 haven't started.
- **Tests and CI:** 1367 tests; CI is green.
- **Performance:** the §3 merge target is met. A 40-file merge has p95 31 ms against the 50 ms target. At 10k files, after-commit p95 went from 380 to 23 ms and apply p95 is 267 ms.
- **What review caught:** two more path leaks, both fixed before merge. One was in the T521 diff (it failed open when every path was denied). The other was `capability.denied` resources reaching every event reader (T702/T703). The fix for the second is a single on-output view, `redactEventFor`.

**Against the §30 demo flow.**

- **Newly working:** step 6 is done up to block/unblock, and step 14's Activity data now exists.
- **Still missing:**
  - step 5 (decisions and memory, M4: nobody has started it);
  - steps 7, 9 and 11–13 (intents, drafts, conflict resolution and health, M6);
  - step 8 (sandboxes, which had no tasks until this review);
  - steps 2 and 17 (Git import and export, M8);
  - the web app, CLI and SDKs (§29, which also had no tasks).

**On track.**

- Security review works. Every new read surface has had per-viewer redaction checked before merge, and the T601 contract (store the full record, redact on output) now covers conflicts and events.
- S1's throughput and test discipline are high: sabotage checks, a 539-case conformance matrix for the task state machine, and missed-message tests for the WebSocket.
- Nothing has been built twice. `redactEventFor` is the one place event visibility is decided.

**Course corrections.**

1. **Still nothing runnable on main.** `apps/server` (T712) has waited about 20 hours in #67 for Peter's merge. Every engineer PR since says it will register its commands "once #67 lands". **Decision:** Peter, please merge #67. If it isn't on main by Review 4, S1 opens the composition root as its own PR from #67's commit, so O1 can review and merge it, and #67 shrinks to docs.
2. **M4 has no progress and sits behind S2's queue.** S2 owns M6 (9 open tasks), M8 (6), M4's decisions and memory (8), T711, T901 and T903, about 26 tasks. S1 owns about 19 and moves roughly 3× faster. **Decision:** all of M4 moves to S1 (T404–T409, T411, T412). S2 focuses on M6, then M10, then M8.
3. **Scope breakdown, overdue since Review 1.** **Decision:** this review adds:
   - **M10 Execution sandboxes** (§14, demo step 8; T1001–T1008, owner S2 after M6). It's adjacent to the workspace engine S2 built, and `changes.submit` is a `SANDBOX` ChangeSet into S2's apply pipeline.
   - **M11 Clients** (§29; T1101–T1105, owner S1 after M7/M4): TypeScript SDK, CLI, Python SDK, web app shell, and then the editor (to be broken down once the shell lands).
   - The plugin runner (§21.4) is MVP scope too: §29 lists server-side GitHub, Browser and AWS plugins. It reuses M10's isolation and egress work and M9's approval gates, so O1 breaks it down at Review 4, once T1001 and T1007 have settled the container model.
4. **Order.**
   - **S1:** M3 chain (#82–#87) → T703 → T708 → M4 (T401–T403, T404–T409, T410–T412) → T709 → T704–T706 → M11.
   - **S2:** T602 → T603–T605 (resolution, escalation, abandon; demo 11–12) → T607–T610 (health; T610 replaces T309's `alwaysGreen` gate) → T606 → T520 → M10 → M8 → T711, T901, T903.
5. **Process.** A stacked child PR must be retargeted to main _before_ its rebase push, because a retarget alone doesn't trigger CI. Run `pnpm check` with `GIT_CONFIG_GLOBAL=/dev/null`, since CI has no git identity (#85).

**Tech-debt register.**

- **Resolved:**
  - workspace path leaks (T521, T601, and `redactEventFor` in T702);
  - compact conflict payloads (T601);
  - the merge and after-commit hot spots (T522, T523).
- **New:**
  - The T703 gap poll runs one `listEvents` per socket every 2 s, about 500 queries/s at 1k idle sockets. Gate it on a cached per-room `last_sequence` before load tests.
  - T906 (owner tombstones) must be applied through the same `redactEventFor` path, so REST, WebSocket and digests can't disagree.
  - Reads don't take the room lease, so `reconcileRef` runs on a room's first mutation. That's safe while reads resolve commits from PostgreSQL; re-check it for anything that reads the ref.
  - In #86, `tasks.heartbeat` is a catalog "read" that writes the lease. That's fine, but document that it bypasses frozen-room write rules on purpose.
  - The T703 `room.events.subscribe` checks its policy once, at subscribe time. A pause or removal is caught by the 30 s token re-check, not immediately.
- **Carried over:**
  - the gateway's `"INTERNAL"` code is still outside `ErrorCode`;
  - the kernel imports `@crossover/policy` helpers (`grants.ts`, `invite.ts`, `join.ts`);
  - there's no index for the event-type and JSONB lookups (T212, T213);
  - non-strict zod in `room.create` and `room.get_state`;
  - the deferred room FKs.

## 2026-10-06 · Review 2 (52 tasks merged, 10 since Review 1)

**State.** Since Review 1:

- The REST gateway (T701) and background lease renewal (T713) merged.
- Platform users and room sessions (T216, T217) merged.
- Most of M2 governance merged: grants and revocations (T210, T219), per-path scoped grants (T218), roles (T211), pause/resume/remove (T212) and lead transfer (T213). T214 is approved and waiting on a rebase, and T215 is in progress.

There are 1201 tests and CI is green. Every emitted event type is in the protocol catalog. Review caught one real security bug before it merged: a scoped DENY was ignored on path-in-resource checks, which failed open.

**Against the §30 demo flow.**

- **Done:** step 1 (create room), steps 3–4 (invites and the lead, but not MCP), step 10 (ChangeSet merge), step 14 (Tier 3 denial; Activity needs T215) and step 15 (pause and resume).
- **Missing:** tasks (steps 6 and 16, M3), decisions and memory (step 5, M4), MCP (step 3, the primary agent interface), conflicts and health (steps 11–13, M6), edit intents and human drafts (steps 7 and 9), sandboxes (step 8) and GitHub import and export (steps 2 and 17, M8).

**On track.**

- Governance is close to complete and well tested, including sabotage checks and races.
- The injected `Authorizer` boundary held: #65 was sent back for calling the policy directly, and it now uses `ctx.authorizeAs`.

**Course corrections.**

1. **Still nothing runnable, and that's on O1.** Review 1 said O1 starts `apps/server` when T701 lands. T701 landed and it hasn't started. **Decision:** O1 builds the T712 composition root now. It wires:
   - the dispatcher with the real policy, every `register*` module, the gateway and the Redis publisher;
   - `LeaseRenewer`, plus `onLeaseAcquire` → `reconcileRef`;
   - `provisionWorkspace`.

   It also adds a smoke test: dev-login → `room.create` → room session → invite → join → `workspace.apply_changeset` → `room.get_state`.

2. **The work is unbalanced and S2 is stalled.** S2 owns about 34 open tasks, including all of MCP, M6 and M8, against about 27 for S1, and has posted nothing since 02:34. MCP is the primary agent interface, and nothing has been built for it. **Decision:** T707–T709 (the MCP skeleton, task tools and collaboration tools) move to S1. S2 keeps T710–T711 (workspace tools), M5, M6 and M8.
3. **Order.**
   - **S1:** T214 rebase → T215 → T707 → M3 (T301–T312) → T708/T709 → T702/T703.
   - **S2:** T521 (path-leak security fixes) → finish T519 → hot-spot fixes → T710 → M6.
4. **Scope still to break down:** sandboxes and execution (§14, demo step 8), human editor drafts and edit intents in the client (step 9), the web UI, the CLI and SDKs. O1 breaks these down after T712.

**Tech-debt register.**

- Resolved: background lease renewal (T713).
- The kernel now imports `@crossover/policy` for pure helpers (bundles, `parseCapability`, `tierOf`). Authorization itself stays injected. Consider moving the capability-string helpers to `protocol` to restore the Review 1 layering.
- The pauser lookup (T212) and lead-offer lookup (T213) scan `events` by type and a JSONB payload field with no index. Add an index on `(room_id, type, sequence DESC)` before M6 load.
- The gateway returns `"INTERNAL"`, which isn't in `ErrorCode`.
- Workspace path leaks: `workspace.list` returns entries outside the scope, and conflict responses name unauthorized paths (T521).
- Merge p95 was about 265 ms (interim T519 numbers) against the 50 ms target. Fix the hot spots before M6.
- Stacked PRs cost a rebase after every squash merge. Rebase children with `git rebase --onto origin/main <old-parent-tip>`.
- Carried over from Review 1: non-strict zod schemas in `room.create` and `room.get_state`, the deferred room FKs, and compact conflict payloads.

## 2026-10-06 · Review 1 (42 of 112 tasks merged)

**State.** M1 done (ledger, leases, fencing, idempotency, dispatcher, publisher). M2 7/15 (participants, room create/state, tokens, authenticate, policy, scopes). M5 16/20 (the full ChangeSet apply pipeline with merge, conflicts, binary, ignore rules, ref reconciliation, reads, diff, history, blame). 929 tests, CI green. Quality is high: race tests are proven by sabotage, and contracts are decided before code.

**On track.**

- The core invariants of §19 and §10 are real and tested: gap-free sequences under one writer, fencing against zombie owners, atomic ChangeSets, PostgreSQL authoritative over Git with reconciliation, and idempotent replays.
- The layering is clean: protocol ← db ← ledger ← kernel ← workspace/policy, with policy injected (no kernel → policy dependency).

**Course corrections.**

1. **Nothing is runnable yet.** There's no `apps/server`, gateway or MCP server; six `register*` modules exist with nothing composing them, and the policy and `provisionWorkspace` are only wired in tests. All integration currently lands on T712 at the end. **Decision:** build a walking skeleton now. S1 takes T701 (REST gateway) right after T205; S2 takes T707 (MCP skeleton) and T710 (workspace tools) right after T517. O1 starts `apps/server` (T712's composition root) as soon as T701 lands, and grows the end-to-end test with every milestone instead of once at the end.
2. **The backlog didn't cover all of MVP scope (§29).** Git import/export, secret scanning, circuit breakers, budgets, approval gates and redaction had no tasks. Added as M8 (T801–T806) and M9 (T901–T906). Still to break down: sandboxes and execution (§14), the plugin runner, the web UI, the CLI and SDKs.
3. **Performance is unmeasured, and debt is accumulating against the p95 < 50 ms merge target (§3).** Full `ls-tree` per merge (T510), full index rebuild per patch op (T504), and an ignore-repo per materialize (T506). **Decision:** pull T519 (benchmark) forward to right after T518, and fix the hot spots it confirms before M6 builds more on the engine.

**Tech-debt register.**

- Non-strict zod schemas in `room.create` and `room.get_state`.
- Deferred FKs `rooms.owner_id`/`lead_participant_id`, pending a shared `createTestRoom` fixture.
- Compact `workspace.conflict.created` payloads (T601).
- No `capability.denied` events yet (T215).
- No background lease renewal (T713).
