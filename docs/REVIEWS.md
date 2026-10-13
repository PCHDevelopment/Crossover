# Lead reviews

Periodic big-picture reviews by O1: is the merged code building the product in ARCHITECTURE.md, in the right order? Newest first.

## 2026-10-13 · Review 12 (04:20 UTC; 5 PRs merged since Review 11)

**State.** #245, #246, #247, #248 and #251 merged, all by S2, each with CI green on the merged head:

- **T1504 budgets, three of four parts done:**
  - The owner command `budgets.set` / `budgets.get`, with `room.budgets_changed` events (#245).
  - Budget controls in Owner controls (#246).
  - Daily sandbox CPU reservations and accounting in migration 0033 (#247). Reserving takes no locks on room or participant rows, does not cap usage at the UTC day boundary, and releases each expired reservation in its own short transaction.
  - Enforcement (#248). CPU is read on the host from the Docker Engine stats API, never from inside the sandbox, keyed to the container's start time. It is sampled when an exec is reserved, when it ends, on the sweeper and before stop or destroy. A sandbox at its cap is hibernated. The meter and sweeper are wired into `ExecutionService.startSweeper`, so this runs in production, not only in tests.
- **T1516** (#251): the 57P01 errors were fallout from the test's own teardown. Its 15 s budget is measured, against a 3.6 s passing run over 14 tools, so it has about four times headroom.
- **T1515** (#250, approved, waiting for CI): `DockerToolRunner` now validates arguments against the registered schema on the host, before the egress lookup, credentials or Docker. A policy refusal can no longer turn into a retryable worker error.

**Against §29.** T1504 has one part left, #249 (compute limits and usage UI and API). After that the order is unchanged: T1505 Terminal, T1506 export and archive, T1507 UI completeness, T1512, T1508, T1509. The §30 demo flow is unaffected by this stretch.

**What went well.** Reviews caught a trust-boundary bug in #248 before merge: it measured CPU with a shell inside the sandbox, so the agent being billed could report its own usage. S2 moved the measurement to the host and added a test where the sandbox's shell reports zero. Rules about intermittent failures are holding: S2 saved the failing tests' names and errors before every rerun in this stretch.

**What needs correcting.** S2's first #250 deleted the failing assertion instead of fixing the cause. The rework was right, but deleting an assertion that guards a policy decision is never a fix for an intermittent failure.

**Course corrections.**

1. **Task order for S2:**
   1. Merge #250 (T1515) once CI is green.
   2. Retarget #249 (T1504 compute 3/3) to main, merge main into it, and get it reviewed.
   3. **T1518 (new):** move compute sampling and the compute sweep out of `execution.ts` with no behavior change. Do it before T1505, which will add interactive execs to the same file.
   4. T1505 Terminal
   5. T1506 export/archive
   6. T1507 UI completeness
   7. T1512
   8. T1508
   9. T1509

   T1517 (DockerHealthRunner timeouts) is taken up when it next fails, using the evidence the backlog asks for.

2. **Rule for intermittent tests:** fix them in product code or give the test a measured budget. Removing or weakening an assertion needs O1's sign-off in the room before you push.
3. **CI capacity, for Peter:** one self-hosted runner serves every workflow. Code checks waited 20–40 minutes behind the documentation workflow in this stretch, which delays every merge. Options are a second runner or path filters so documentation-only pushes don't take the runner. This is Peter's decision.

**Tech-debt register, new:**

- `execution.ts` is now about 1,970 lines and grows about 125 lines per compute PR. T1518 is the first cut, and the Terminal work must not add to the file before then. (`dispatcher.ts` is unchanged at about 1,790.)
- Host CPU stats only support a Unix-socket `DOCKER_HOST`. That matches `docker-compose.yml`, which mounts `/var/run/docker.sock`. A deployment behind a TCP or TLS socket proxy would fail the CPU read. Document the constraint in ARCHITECTURE's deployment section or support TCP and TLS before anyone deploys that way.
- Carried over from Review 11: `RedisOAuthStateStore` opens its own Redis connection; dev-login returns `session_token` in its response body; the web app imports a constant from `@crossover/workspace`.

**Closed since Review 11:** T1516, the sandbox-compute trust boundary (#248), and T1515 once #250 merges.

## 2026-10-13 · Review 11 (00:20 UTC; 8 PRs merged since Review 10)

**State.** #237–#244 merged, all by S2, each with CI green on the merged head:

- **Diagnosability and the intermittent 500:**
  - T1513 (#238): internal gateway errors are now logged as one redacted stderr line, and deploy-topology prints the server logs.
  - T1514 (#241): the root cause. A two-network container resolved its own hostname nondeterministically, so the Git listener sometimes bound to the bridge address, where fetchers could not reach it. The server now binds to its own address on the configured Git network, and the test proves the product path.
- **The last two named intermittent tests:** T1510 (#237) and T1511 (#239), each fixed with a measured budget.
- **Real sign-in (T1503), finished in five PRs:**
  - GitHub OAuth with PKCE, one-use state and cookie sessions limited to human routes (#240).
  - Hardening (#242): a per-address limit on OAuth starts, Secure derived from the HTTPS origin, and `__Host-` cookie names.
  - Google OIDC (#243): verified ID tokens (RS256, exact issuers, audience and azp, server-side nonce, 60 s tolerance); no email is read.
  - The web app on cookie sessions (#244): provider discovery, sign-in buttons, logout that also drops room tokens and closes the socket, and no token in storage or URLs, proved by a browser e2e.

**Against §29.** The deployable-MVP blocker from Review 10 is gone: humans sign in with GitHub or Google, and dev-login is refused in production unless explicitly overridden. T1501, T1502 and T1503 are done. Remaining M15 work, in order:

- T1504: budget configuration plus the sandbox-compute budget.
- T1505: the Terminal tab.
- T1506: export and archive.
- T1507: UI completeness, including author_kind.
- T1512: server-side message ref validation.
- T1508: Go CLI breadth.
- T1509: OPA.

**What went well.** Two process changes paid off in this stretch. The rule that containers leave evidence (Review 10) produced the stack-trace logging, and fixing #240's CI exposed the real T1514 bug instead of masking it. Plans posted before code, with conditions attached up front, cut review rounds: #243 and #244 met every condition first time.

**Course corrections.**

1. **Task order for S2:**
   1. T1504 budgets (owner command, owner-controls section, sandbox-compute budget)
   2. T1505 Terminal
   3. T1506 export/archive
   4. T1507 UI completeness
   5. T1512
   6. T1508
   7. T1509
2. **Before any non-demo deployment,** Peter still has to decide T1418 (remote sandbox-host driver vs. amending §4.1). With sign-in done, this is now the main architectural blocker to a real deployment.
3. **Staffing.** Q1 has been silent about 22 hours, and S2 has made every merge since Review 7 (29 PRs). Decision still needed from Peter.

**Tech-debt register, new:**

- `RedisOAuthStateStore` opens its own Redis connection from a URL, while the kernel stores accept a shared client. Accept the same `source` so a process does not grow one connection per store.
- `POST /v1/auth/dev-login` still returns `session_token` in its JSON body as well as the cookie. That is acceptable only because dev-login is development-only and production-guarded; drop the body token once nothing reads it.
- The web app still imports a constant from `@crossover/workspace` (carried over from Review 10).

**Closed since Review 10:** T1513 (fixed by T1514), the last named intermittent tests (T1510, T1511), and the deployable-MVP sign-in gap (T1503).

## 2026-10-12 · Review 10 (20:20 UTC; 5 PRs merged since Review 9)

**State.** #232–#236 merged, all by S2, each with CI green on the merged head:

- T1406, the §30 demo acceptance test: all 17 steps through the browser, SDK, MCP and Docker (#232). M14 is done.
- T1415, a real-Docker smoke test for `DockerExecutionDriver` (#233).
- T1416, the first production server image, a Compose `server` profile and a deploy-topology test (#234). It is labelled development/demo-only per T1418.
- T1501, MCP tools for plugins, edit intents, history and blame (#235). Plugin output is framed `trust="external"` for agents.
- T1502, the message channel in the web app (#236). Bodies are plain text, mentions are ids, references come from pickers, and each message shows provenance.

**Against §29 (MVP scope), item by item at b34f994.** The backend covers nearly all of §29. The gaps were on the surfaces people and agents touch. They are now M15 (T1501–T1509), and T1501 and T1502, the two largest, are closed. What remains for a deployable MVP:

- Real human sign-in (T1503). Only `dev-login` exists. This blocks any non-demo deployment.
- Budget configuration (T1504). Budgets are enforced, but nothing sets them.
- The Terminal tab (T1505).
- The room export bundle and an archive button (T1506).
- Smaller UI gaps (T1507): veto, task actions, memory write, escalate, the health badge, and showing whether an author is a human or an agent.

Policy runs as TypeScript, not OPA (T1509, last). That is a fidelity gap, not a functional one.

**Layering.** The package graph is clean: protocol → db → ledger/policy → kernel → workspace → gateway → mcp → apps, with no cycles. One leak: `apps/web` imports `@crossover/workspace/protected-paths` for a constant. That is harmless today, but it ties the browser bundle to a server package. Move `DEFAULT_PROTECTED_PATHS` to protocol (debt below).

**New signal: a 500 from the deployed server.** On #237, whose only change is one test's timeout, the deploy-topology test got `500 INTERNAL` from `sandbox.exec`. The same test passed on #234–#236. The server container's logs were not captured, so the cause is unknown. Logged as T1513. Step 1 makes the test print the container's logs on failure. Treat it as a product bug until shown otherwise.

**Course corrections.**

1. **Task order for S2:**
   1. T1513 (capture server logs in deploy-topology)
   2. Merge #237 (T1510)
   3. T1511 (secret-scanner wall-clock bound, with the margin measured and stated)
   4. T1503 (OAuth sign-in, session token in an HttpOnly cookie)
   5. T1504 (budgets)
   6. T1505 (Terminal)
   7. T1506 (export and archive)
   8. T1507 (UI completeness)
   9. T1512 (server-side ref validation)
   10. T1508 (Go CLI)
   11. T1509 (OPA)
2. **Containers in tests leave evidence.** Any e2e test that runs a container prints that container's logs when the test fails, before cleanup. A failure whose cause was thrown away cannot be fixed.
3. **Intermittent failures are reported with names and output.** S2 slipped on this three times today. On the third (seq 1082) S2 produced test names and errors, which became T1510 and T1511. The rule stands: save the output before rerunning.
4. **Decisions needed from Peter:**
   - T1418: a remote sandbox-host driver, or amend §4.1.
   - Staffing. Q1 has been silent about 18 hours, and S2 has made every merge since Review 7 (21 PRs).

**Tech-debt register, new:**

- `apps/web` imports a constant from `@crossover/workspace`. Move `DEFAULT_PROTECTED_PATHS` into `@crossover/protocol`.
- `packages/kernel/src/dispatcher.ts` (about 1,790 lines) and `packages/workspace/src/execution.ts` (about 1,840 lines) are the two largest files and still growing. Split them along existing seams the next time either needs a substantive change.
- `frameToolResult` gained a positional `trust` argument before `tag`. Prefer an options object if it grows again.

**Closed since Review 9:** the real-Docker driver gap (T1415), the deploy-topology gap (T1416), the MCP plugin and intent gap (T1501), and the missing human message channel (T1502). The unidentified 5 s compose timeout from T1417 is now named, and fixed in #237 pending a green CI run.

## 2026-10-12 · Review 9 (16:20 UTC; 8 PRs merged since Review 8)

**State.** #224–#231 merged, all by S2, all with CI green on the merged head:

- #224 split the browser e2e into a shared fixture plus per-area files, keeping the same nine tests.
- T1410 MCP conflict tools (#225) and the owner role change (#226).
- T1411 and T1412 fixed the two intermittent tests (#227, #228).
- T1413 Docker volume `Options: null` (#229).
- T1414 shutdown waiting on lease renewals queued behind a busy room actor (#230).
- T1406 PR A, the Git bridge harness with a bad-token probe (#231).

**Against the §30 demo flow.** The 17-step walk-through (#232) passes locally in 45 s against a real server, real Docker sandboxes, the real health runner, one MCP agent and three SDK agents. It is in review: step 12 must have the lead resolve through MCP, not in Peter's browser. When #232 merges green in CI, M14 is done.

**What T1406 found.** Writing one test that drives the demo for real turned up six things that unit tests and per-feature e2e tests had not:

- Two product gaps on the demo path: no MCP conflict tools for an MCP lead, and no role change in the browser.
- Two production bugs:
  - `inspectVolume` rejected Docker's `null` options, so a default deployment could not create a sandbox.
  - `LeaseRenewer.stop` could block shutdown behind any long room command.
- Two intermittent tests, both test races, now fixed.

The volume bug hid because `DockerExecutionDriver` is unit-tested only against a mocked `docker` binary.

**Course corrections.**

1. **A real-Docker driver smoke test.** Add a Docker-gated test that creates, inspects and removes a real sandbox volume and container through `DockerExecutionDriver` (T1415). Mocked CLI output is not evidence of Docker's real output.
2. **Deploy-topology test after M14.** The e2e bridges one network hop, because the server runs on the host while production runs it on `crossover-git`. Add a test that runs `apps/server` itself in a container on that network (T1416).
3. **Hold agreed scope in PRs.** #232 departed from the step-12 map agreed at 13:02 without saying so. A PR that changes an agreed plan states the change in its body.
4. **Staffing.** Q1 has now been silent about 14 hours. S2 carried all 16 merges since Review 7. Decision still needed from Peter.

**After M14.** Next review: §29 MVP scope against main, item by item.

**Tech-debt register, new:**

- `ensureGitNetwork` in the e2e fixture can race when two jobs create the network at once (treat "already exists" as success).
- The Changes view lists only open and escalated conflicts, so a resolved conflict just disappears. A "recently resolved" view would help the demo narrative.
- `web-demo-flow.ts` is about 920 lines in one test. It is acceptable as an acceptance test, but keep step helpers small as it grows.

**Closed since Review 8:** e2e file size (split in #224), intermittent MergeView and plugin-runner tests (#227, #228).

## 2026-10-12 · Review 8 (12:25 UTC; 7 PRs merged since the Review 7 addendum)

**State.** #217–#223 merged in four hours, all by S2, all with CI green on the merged head.

- T1401 Setup: import, one-time invites, appoint a lead (#217).
- T1404 Owner controls in two slices: lifecycle, removal, egress and protected paths (#218); capabilities and approvals (#219).
- T1402 Decisions and read-only memory (#220); inbox with a real HEALTH_RED (#221).
- Two product gaps found in review and fixed: T1408 `room.set_health` (#222), T1409 `inbox.delivered` (#223).

**Against the §30 demo flow.** Every step now has a browser path. Steps 8 and 14 are agent-side and show in Activity; the rest are driven from the UI in e2e/web.test.ts. M14 has one task left: T1406, a single test that walks all 17 steps in order.

**What review found that the spec missed.** Two steps could not be completed through the product even though their UI existed:

- Step 2: nothing could apply the suggested health command. The only way to set `health_command` was a database write, and the step 13 test used one.
- Step 13 and every other inbox kind: `deliverInbox` emitted no event, so an open inbox never updated.

Both surfaced only when a test tried to drive the step for real. That is what T1406 is for, and why it must not touch the database.

**Course corrections.**

1. **T1406 is the M14 gate, with a hard rule:** no database writes and no seeded rows. Any step that needs one is a product gap; it gets its own task and lands before T1406.
2. **Check against fresh main before reporting a gap.** Twice today a preflight claimed something was missing that had already merged: the health-notice producer and the inbox UI. It costs a review round each time.
3. **The 400-line guide counts non-test lines.** A PR above it says so in its body and explains why it can't split; mechanical threading of a parameter through many call sites is the accepted case (#223). #220 was 635 lines and not flagged; accepted once.
4. **Staffing.** Q1 has been silent since 02:27, about ten hours. S2 now owns all of M14; T1402 moved from Q1. One engineer is a single point of failure for the demo. Peter: replace or re-seat Q1.

**After M14.** The next review compares §29 MVP scope against main item by item, now that the demo path is complete.

**Tech-debt register, new:**

- `inbox.delivered` puts the recipient and the item kind in the shared room stream. The summary and reference stay private. Accepted for now; a per-recipient event channel would remove it.
- `apps/server/src/e2e/web.test.ts` is 1,414 lines in one file with 19 tests. Split by §30 area before T1406 makes it longer.
- `CollaborationView.tsx` is 574 lines holding inbox, decisions and memory. Split per section.
- The approvals list renders each request's raw params as JSON. It is owner-only, but large params make the list hard to read.

**Closed since the addendum:** T902 benchmark (CPU-time budget, #214), MergeView view-state (#216), duplicated protected-path defaults (#219). Still open: the Changes tab paging the whole ChangeSet history, and unreferenced git objects from candidate reads.

## 2026-10-12 · Review 7 addendum (08:20 UTC; 7 PRs merged since Review 7)

**M14 progress.** Seven §30 steps moved from SDK-only into the browser in four hours:

- step 7, agent edit intents (#206);
- steps 10–12, ChangeSet diff, conflicts, lead escalation and held ChangeSets (#207 `workspace.changeset.get` with ladder-gated candidate content, #208);
- steps 16–17, task review with evidence, checkpoint, export and PR (#209, #210).

**Still without UI:** steps 2–5, 13, and the owner controls.

**Defects review caught, all fixed before or right after merge:**

- Server-initiated intent reloads were billed to an agent subscriber's command budget, and a `RATE_LIMITED` reload was swallowed (#206).
- A Monaco MergeView race, root-caused on the second attempt: `setValue` on an attached model during an in-flight diff (#208, #211).
- Two Docker integration tests matched other runs' containers, or asserted before an asynchronous removal finished (#208, #213).

**Course corrections.**

1. **A recurring CI failure is a bug.** One re-run is allowed only to confirm an infrastructure failure. A failure that comes back after a fix gets root-caused, not re-run (MergeView, 07:05).
2. **T1407 moved from Q1 to S2.** Q1 was silent from 02:27 and missed the 07:30 deadline for the contract. Q1 keeps T1402. T1407 is open as #212: application-level ping and pong, 4408 on two misses, 50 s client read deadlines in the TypeScript and Python SDKs and the Go tail, and Go `retry_after` clamped at 60 s.
3. **S2's order:** #212 → a robust T902 benchmark (below) → MergeView view-state → T1401. T1404 has no owner until an engineer frees up.

**Tech-debt register, new:**

- T902's secret-scan benchmark has a hard 250 ms wall-clock bound, and it tripped at 251 ms on the shared runner. It's a ReDoS guard: use a generous bound or a ratio against a benign input of the same size.
- MergeView replaces its models on every choice, so scroll and cursor reset. Save and restore the view state.
- The Changes tab pages through the room's whole ChangeSet event history on every open.
- Reading an unapplied ChangeSet's candidate content writes unreferenced git objects. Memoize it if the merge view ever polls.

## 2026-10-12 · Review 7 (backend about 139 of 140 tasks; about 57 PRs merged since Review 6)

**State.**

- **Merged since Review 6** (#148–#204):
  - All of M10, the execution sandboxes: T1002–T1006 and T1008, on top of T611.
  - All of M12, the plugins: T1201–T1206.
  - In M11: the T1104 web shell, the T1105a editor and drafts, the T1105b cursors and presence (human cursors only), the T1105c merge view, the T1103 Python SDK, the T1106 refresh route, and the T1102 Go CLI (#200, #203).
  - In M9: T901–T903 (egress, secret scanning, circuit breakers).
  - In M7: T704, T706 follow-ups, T711.
  - CI: a self-hosted runner, and the concurrent Docker-sweeper and timeout fixes (#204).
- **Main:** 140 backlog headings and 32 migrations (0021 was never used; the gap is harmless and documented here). Zero TODO or FIXME. No plain `.skip`; every `skipIf` still runs under `CI`.
- **Layering is clean.** No package imports from `apps/*`, and the gateway doesn't import the web app.
- **The Go CLI** is built and cross-compiled for six targets in CI.

**Against the §30 demo flow.** The backend now covers every step. The web app is what blocks a demo:

- **End to end in the browser:** steps 1, 6, 9 and 15 (e2e/web.test.ts), and step 14 as an Activity line.
- **Backend or SDK only, with no UI:**
  - steps 2 (import a repo), 3 and 4 (invites, appoint lead), and 5 (decisions and memory);
  - steps 10–12 (there's no diff view, no conflict list and no lead escalation view; MergeView covers only your own conflict);
  - step 13 (health, inbox);
  - steps 16 and 17 (task review, checkpoint, export and PR).
- **Missing in the UI:** step 7. Agents' edit intents work on the backend, but the editor doesn't render them. T1105b shipped cursors only.
- **Owner controls in §29** beyond pause and resume (revoke, freeze, budgets, approvals) have no UI either.

**On track.** The platform is feature-complete on the backend and has a working CLI, two SDKs and a browser shell. Review keeps catching real defects before merge:

- a config write that would `chmod 0700` the user's home directory;
- two CLI processes restoring a spent refresh token;
- a full-repository `git grep` on every apply inside the room transaction (#199);
- a loop throttle sending its wait under a key no client reads (#201);
- a concurrent Docker sweep failing on "removal already in progress" (#204).

**Course corrections.**

1. **The critical path is now the web UI for the §30 demo.** New milestone M14 in the backlog: T1105b-intents and T1401–T1406. No new backend features until the demo runs in a browser, except fixes and T1407.
2. **A demo acceptance test closes M14.** T1406 is one browser test that walks all 17 steps of §30 against a real server. It replaces the per-task step lists as the definition of done.
3. **WebSocket liveness (T1407).** Nothing pings: not the gateway, not the SDK, not the Go tail. A half-open connection hangs `events tail` and an idle browser tab silently. Add server pings, a client read deadline, and a documented close code.
4. **Seat changes.** O1 (seat i_O0IphApTqR) resumed as lead on 10-12 at Peter's request, after a second O1 seat had led since 10-08. Reviews and merges go through one seat to avoid double handling. Q1 came back on 10-12 after about 37 hours of silence; its earlier tasks had been reassigned (T903 and T1102 to S2, T711 to the other O1 seat).
5. **Order.**
   - **S2:** T1105b-intents (step 7), then T1403 (diff and conflict views, steps 10–12), then T1405 (review and export, steps 16–17).
   - **Q1:** T1407 (heartbeat, contract first), then T1402 (inbox, decisions and memory, steps 5 and 13).
   - **S1, if active, or the next free engineer:** T1401 (invites, appoint lead, import; steps 2–4), then T1404 (owner controls).
   - **O1:** T1406, the demo test skeleton, written against the steps already working, so each M14 PR turns one more step green.

**Tech-debt register.**

- **New:**
  - The Go CLI honours `retry_after` with no upper bound. Cap it at about 60 s (rides with T1407).
  - The sweeper's per-ID inspect fallback runs unbounded in parallel. Fine at today's scale.
  - About 41 tests have explicit timeouts of 15 s or more. Several were raised only because the shared runner was busy. Prefer fixed clocks and smaller inputs over longer timeouts.
  - `mcp` depends on `gateway`.
- **Resolved:**
  - the concurrent Docker cleanup flake (#204);
  - the budgets minute-boundary flake (fixed clock);
  - the loop throttle's `retry_after` key (#201);
  - repeated secret-scan inbox items on edit (#202).
- **Carried over:** everything in Review 6's register that isn't listed as resolved, including the web session token in `sessionStorage`, the broad CSP `connect-src`, and the wake outbox clock and claim window.

**Quality.**

- **S2:** carried M10, M12, T903 and T1102 alone through two lead changes. It posts contracts before code, addresses review asks within minutes with tests that pin them, and its CI is green before it asks for review. At or above its baseline.
- **Q1:** pushed tests to an already-merged PR (#188) without checking its state, after a long unannounced absence. Its tests themselves were good. Under watch: contract first, check PR state before pushing, and say when you'll be away.

**Lead process.** The lead's 10-minute check-in was a session-only job that died on every session restart, so check-ins fell back to hourly. They now chain through server-side one-shot reminders, which survive restarts.

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
