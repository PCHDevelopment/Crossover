# Lead reviews

Periodic big-picture reviews by O1: is the merged code building the product in ARCHITECTURE.md, in the right order? Newest first.

## 2026-10-07 · Review 6 (about 110 of 141 tasks; 8 PRs merged since Review 5)

**State.**

- **Merged since Review 5:**
  - T805 checkpoint export and T806 PR on export (with T806b scrubbing provider errors), so M8 is complete.
  - T807, the dispatcher prepare phase.
  - T905 follow-ups.
  - T1101, the TypeScript SDK.
  - T1106 `POST /v1/auth/refresh`.
  - T706 wake webhooks (a Postgres outbox).
- **Demo step 17** (checkpoint → export → PR) now works on the backend.
- **Open:**
  - S1: T1201 (#150), T1106 leftovers (#151), T1104 web shell (#152), T704 (#153), T1103 Python SDK (#154).
  - S2: T611 (#148).

**Against the §30 demo flow.** No change since Review 5, except that step 17 now works. Step 8 (sandbox exec) is still blocked on M10, behind T611. Steps 7 and 9 and the UI wait on T1104/T1105.

**On track.** Review keeps catching real defects before they merge. This round found:

- a ReDoS in subscription type patterns;
- refresh retries that revoke the whole login when a response is lost;
- `TRUST_PROXY` trusting a forged `X-Forwarded-For`;
- a tool that runs and then reports key reuse;
- a crashed reinstall's half-written cache being mounted for health runs.

**Course corrections.**

1. **WIP limit: at most two open PRs per engineer, and blockers first.** S1 opened five PRs in about 90 minutes while three earlier ones waited on rework. Four of the five came back with blockers. Parallel PRs pile up rework and merge conflicts (#152 already conflicts with #147). From now on, fixing review blockers comes before starting a new task.
2. **Order deviations.** T1103 (Python SDK) and T704 were started ahead of the agreed order (T1201 → T1106 → T1104 → T1105 → T905 → T902 → T704–T706). Both PRs stay open. New work follows the order below.
3. **T704 contract (backlog updated).**
   - Relevance is decided from the event payload alone, so events carry `owner_id`, `reviewer_id` and author as of the event. That way a replay with `after` equals live delivery.
   - Type patterns match without building a regex.
   - `relevant` includes `task.created` for unassigned tasks and review requests.
4. **T1106 contract.** The SDKs send a refresh exactly once and never retry it automatically. The server gets a 30-second grace window: presenting the immediately previous refresh token, while its successor is still unused, rotates again instead of revoking the family. `TRUST_PROXY` becomes a hop count or a CIDR list.
5. **T1105 is split** into editor + drafts, live intents + cursors, and merge view. S1 adds the split in its first T1105 PR.
6. **CI rule.** Acceptance tests that need an external tool (Chromium, Python, Docker) must fail, not skip, when `CI` is set and the tool is missing.
7. **Order.**
   - **S1:** #152 → #150 → #151 → #153 → #154 → T706 follow-ups → T1105a–c → T905 remainder.
   - **S2:** #148 → T1002 → T1003 → T1005 → T1006 → T1004 → T1008 → T1202–T1206.
   - **Q1 (new engineer, joined 20:46 UTC):** T901 → T902 (one shared scanner) → T903 → T705 → T711 → T1102. These move off S1 and S2, so the M10 critical path (S2) and the M11/M12 work (S1) lose nothing.

**Tech-debt register.**

- **New:**
  - The wake outbox's claim only protects for `windowMs`, so assert `deadline < window`.
  - It uses node clocks rather than the database's `now()`.
  - Rows for agents without a URL never clear.
  - The web session token sits in `sessionStorage` (move to an HttpOnly cookie, and add a logout route).
  - The CSP `connect-src` is too broad.
  - `/v1/rooms` and `/session` are outside the T1301 conformance enumeration.
  - The filtered streams have no server watermark, so a quiet agent re-scans history on every reconnect (propose a `progress` frame).
- **Carried over:** everything in Review 5's register that isn't listed as resolved.

**Quality.**

- **S1:** fast, and its second passes fix what was asked, with tests that fail when the fix is reverted (#147). But first passes are slipping as volume rises.
- **S2:** T611 needed a third round. The second pass fixed the named items, but claimed "only after SUCCEEDED" without enforcing it, and the crash and reinstall cases weren't tested.

**Lead process.** The lead hit a usage limit and was away about three hours (11:00–13:45 UTC). The PR queue grew from three to seven open PRs in that time. The WIP limit above bounds what can pile up during an outage.

## 2026-10-07 · Review 5 (105 of 139 backlog tasks merged, about 25 PRs since Review 4)

**State.**

- **Milestones:** M1–M6 are complete (M5 20/20 with the T520 parse check; M6 with T606 intents and the T609/T610 health gate). M13 is complete (T1301 visibility conformance, T1302 evidence on submit, T1303 `manifest_changed`). M4 is complete (decisions with veto, supersede and the memory mirror; memory CRUD; loop protection; provenance labels including the inbox). M7 is at 10/13 (T704–T706 and T711 remain). M8 is at 3/7 (import, health suggestion, pull upstream). M10 is at 1.5/9 (T1001 lifecycle; T1007 isolation, with the T1007b proxy in review as a five-part stack). M9 has T904 and T906 in review. M11 and M12 haven't started.
- **Runnable product:** `apps/server` composes everything above. An agent can join over MCP, collaborate (messages, inbox, memory, decisions, digest, tasks), apply ChangeSets that merge, conflict, escalate and get health-gated, and the owner can import a GitHub repository and pull upstream changes. About 2460 tests; CI is green with real Docker.

**Against the §30 demo flow.**

- **Working end to end (backend):** steps 1–6, 10–13, 15 and 16. Step 2 now works for public repositories (import plus the suggested health command).
- **Partial:** step 7 (intents exist; no editor), step 8 (sandboxes are created and isolated, but there's no `sandbox.exec`, materialize or submit yet: T1002–T1006), and step 14 (capability denial works; there's no `tools.invoke` or AWS plugin).
- **Missing:** step 9 (drafts and the editor, M11), step 17 (checkpoints are in review as T804; export and PR are T805/T806), and every UI step (M11). A demo of step 13 on a real Node repository also needs T611, because health runs have no network, so no `node_modules`.

**On track.**

- The §34 rules are now enforced by machinery, not review. Every read declares a participant view and one test scans every surface (T1301). Provenance labels cover every agent-facing read, including the inbox (T412, #125). Evidence is a protocol field (T1302), and model or client changes are events (T1303).
- Security review keeps paying off before release: path-name disclosure through edit intents (#115), loop detection that could be evaded with neutral events (#117), Docker resources orphaned by transactional side effects (#118), redirect SSRF and host Git config in `git.import` (#127), and idempotent retries charged against budgets (#134).

**Course corrections.**

1. **The critical path is now M10 (step 8) and M11 (steps 7, 9, UI).** M10 belongs to S2: T1007b → T611 → T1002 → T1003 → T1005 → T1006 → T1004 → T1008. M11 is S1's largest block. It starts after M8 and T807, before the remaining M9 and M7 items, because the demo is a web app.
2. **T1201 (tool registry, `tools.invoke`) moves to S1**, so that step 14 doesn't wait behind S2's M10 queue. S2 keeps the runner and plugins (T1202–T1206).
3. **New tasks:** **T1007b** (the egress proxy, split out of T1007, in review) and **T807** (a dispatcher prepare phase, so slow I/O such as upstream fetches doesn't hold the room lease; it also splits pulls larger than 500 files). T803's spec now names the caller as submitter of record.
4. **Stacking:** S2 split T1007b into five stacked PRs. Each is reviewable, but squash-merging bottom-up forces a rebase of every later part. The rule stands: open the next part after the previous one merges, unless the lead agrees to a stack up front.
5. **Order.**
   - **S1:** #131 T804, #132 T906, #134 T904 (fix) → T805 → T806 → T807 → T1201 → T1101 (TS SDK) → T1106 (token refresh) → T1104 → T1105 → T905 → T902 → T704–T706.
   - **S2:** T1007b stack → T611 → T1002 → T1003 → T1005 → T1006 → T1004 → T1008 → T711 → T901 → T903 → T1202–T1206.

**Tech-debt register.**

- **Resolved since Review 4:** the e2e split (most new module tests now live in `apps/server/src/e2e/`); memory delete checks namespaces; frozen rooms are skipped by every platform sweep (`runSystem` `whenFrozen`); sandbox cleanup is retried.
- **New:**
  - `presence.list_intents` SCANs the Redis keyspace; index intents per room before the editor polls them.
  - `memory.list` sorts with `COLLATE "C"`, which the default-collation `(room_id, key)` index can't serve.
  - Upstream fetches hold the room lease (T807). An import downloads the whole tip before the 256 MiB check.
  - Server-side fetches should go through the egress proxy once T1007b lands (DNS rebinding).
  - Task descriptions are labeled with the creator only, and evidence isn't labeled with the submitter's provenance.
  - The state-change prefixes in loop protection are defined twice (`isStateChange` and the SQL regex).
  - Sandbox cleanup doesn't cover `DELETED` rooms.
  - `room.get_state`'s `view_reason` should warn that adding conflicts or events would make it `participant`.
- **Carried over:** the T703 per-socket poll; the gateway's `"INTERNAL"` code is outside `ErrorCode`; the kernel imports policy helpers; no index for event-type and JSONB lookups; `tasks.heartbeat` is a catalog read that writes.

**Quality.** S2 (since the model change): first passes still often need a blocking round (#113, #118 with two red CI pushes), but second passes are reliably at baseline. The last four S2 PRs (#121, #124, #126 and the T1001 follow-up) passed on the first round with CI green on push. S2 asks good scope questions before coding (T606, T1001 disk quota, T1007 proxy). S1 is fast and thorough, though twice it skipped an instruction to do a follow-up first (the inbox provenance), and it twice shipped locale-dependent ordering bugs (#109, #127).

**Lead process.** The lead's container restarted three times today. Each restart lost the five-minute check-in job and the local services, and once cost about 55 minutes of review latency with S2 blocked on a question. The hourly safety-net routine recovered it each time. §34.8's server-side reminders would remove this class of problem for Crossover's own agents.

## 2026-10-07 · Review 4 addendum: §34 proposals adopted

Peter accepted O1's recommendation. Three §34 proposals become M13 (S1):

- **T1301 Egress visibility conformance test (§34.5):** every read surface declares its participant view, and one test checks all of them.
- **T1302 Evidence on submit (§34.3):** the acceptance map becomes a `tasks.submit` field, with an optional room-level requirement.
- **T1303 `participant.manifest_changed` (§34.6):** a model or client change is an event plus an inbox item for the lead and owner.

**Order:** S1 → #109, #100 → T1301 → T411 → T412 → T709 → T1302 → T1303 → M8 → … T1301 comes before T709 so the new MCP tools are covered by the test from the start. The #111 follow-ups (owner decide after a veto; refusing a supersede whose target is no longer accepted) ride with T1301 or come as a small PR before it.

**Tech debt added since Review 4:** `presence.list_intents` SCANs the Redis keyspace (index intents per room before the editor polls them, T606); `memory.list` sorts with `COLLATE "C"`, which the default-collation `(room_id, key)` index can't serve (add a `COLLATE "C"` index if lists grow); local checks run on a C-locale cluster, so locale bugs only show in CI (#109).

## 2026-10-07 · Review 4 (86 of 127 backlog tasks merged, about 20 since Review 3)

**State.**

- **Milestones:** M1, M2 and M3 are complete (tasks, including a 539-case state-machine conformance test). M5 is at 19/20. M6 is at 7/10: conflict reads, resolution, escalation, abandon, the health runner and coalescing. M7 is at 8/13: REST reads, WebSocket and MCP task tools. M4 is at 6/12: messages, inbox and producers, the digest, decision proposals and memory put. M8–M12 haven't started.
- **Runnable product:** `apps/server` (#67, #95) composes everything merged and serves REST, WebSocket and `POST /mcp`. An agent can join, take a task through its whole lifecycle over MCP, apply ChangeSets, resolve and escalate conflicts, and have health checks run in an isolated container. There are about 2170 tests; CI is green, with real-Docker tests in CI.

**Against the §30 demo flow.**

- **Working end to end:** steps 1, 3–4, 6, 10–12, 14 and 15.
- **Partial:** step 5 (proposals and positions; decide and the memory mirror are T405/T407) and step 13 (the runner and queue exist; events, suspects and the review gate are T609/T610).
- **Missing:** steps 2 and 17 (M8 Git import/export), 7 and 9 (edit intents T606 plus the editor, M11), 8 (sandboxes, M10) and 16 (the health-gated approve, T610).

**On track.**

- **The §34 visibility rule is real:** `redactEventFor` covers REST, WebSocket and the digest; conflict reads redact per viewer; platform work runs as `system` through `Dispatcher.runSystem`, which skips frozen rooms (#100).
- **Review keeps catching what tests miss:** the `capability.denied` path leak (T702/T703), conflict de-escalation (T603), the Docker timeout and checkout ownership (T607), submitter impersonation in the escalation sweeper (T604), and lease expiry for paused agents (T311). All were fixed before release.
- **Evidence is now standard in PR bodies:** acceptance map, sabotage checks and the CI run.

**Course corrections.**

1. **S2's queue is the critical path.** S2 owns all of M6's remainder, M10 and M8, about 25 tasks, while S1 will finish M4 soon. **Decision:** M8 (Git import/export, demo steps 2 and 17) moves to **S1**, after M4 and T709. S2 keeps M6 → T611 → M10 → M12, which all build on its Docker and egress work.
2. **Scope breakdown, as committed in Review 3:**
   - **M12 Plugins** (§21.4–21.5, T1201–T1206, S2): the tool registry with `tools.invoke`, runner isolation, integrations plus the credential broker, and the GitHub, Browser and AWS plugins (§29's MVP set).
   - **T611:** a per-room dependency cache filled by an egress-proxied install step, so offline health runs can test real projects.
3. **Shared-file churn.** Four PRs in an hour conflicted in `apps/server/src/compose.test.ts`. **Decision:** split the per-module end-to-end tests into `apps/server/src/e2e/<module>.test.ts` (S1, in #100), so new modules add files instead of editing a shared one. This is §34.2 applied to our own repo.
4. **Order.**
   - **S1:** #100 → T405 (plus `decisions.get/list`) → T407 → T406 → T409 → T411 → T412 → T709 → M8 → T704–T706 → M9 (S1 parts) → M11.
   - **S2:** T609 → T610 → T606 → T520 → T611 → M10 → M12 → T711, T901, T903.
5. **§34 proposals:** still waiting for Peter's selection. O1 recommends three first: the egress visibility conformance test (§34.5), evidence on submit (§34.3) and `participant.manifest_changed` (§34.6).

**Tech-debt register.**

- **Resolved since Review 3:** the composition root is on main; event-stream path leaks; health-run cancellation on shutdown; frozen rooms and paused agents in platform sweeps (#100, in review).
- **New:**
  - When the §17.3 digest gains workspace sections, paths must be filtered per viewer. The guarantee becomes "identical for the same viewer and range".
  - `memory.delete` (T409) must call `assertMemoryWritable` itself, because `putMemory` deliberately doesn't check namespaces.
  - Inbox summaries slice by UTF-16 units, so slice by code point once, inside `deliverInbox`.
  - `apply` schedules health for every applied revision on the room's node. Fine for one node per room; T609 events must go through `runSystem`.
- **Carried over:**
  - the T703 per-socket 2 s poll (gate it on a cached `last_sequence` before load tests);
  - the gateway's `"INTERNAL"` code is outside `ErrorCode`;
  - the kernel imports `@crossover/policy` helpers;
  - there's no index for the event-type and JSONB lookups;
  - `tasks.heartbeat` is a catalog read that writes;
  - non-strict zod in `room.create`/`get_state`.

**Lead process (O1's own slips, so the team can hold me to them).**

- I merged #84 having assumed T310 was already reviewed. I reviewed it after the fact and posted a correction.
- I posted "merged" for #99 before the merge succeeded.
- I passed guessed abbreviated SHAs to merge calls twice.

**Rule from now on:** O1 reviews a diff before approving it, even when it's "patch-identical"; announces a merge only after the API confirms it; and passes full SHAs from `git rev-parse`.

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
