# Agent Collaboration Platform — Technical Architecture

**Version 0.2** · Revision of v0.1 that closes the gaps found in the design review. Product decisions from the original conversation are unchanged. Technical decisions made in this revision are recorded in §0.2 with their reasoning so any of them can be revisited.

---

# 0. About This Revision

## 0.1 What changed from v0.1

| Area | v0.1 | v0.2 |
|---|---|---|
| Authority | Lead was the only authority role | Separate **Room Owner** (always human) with override over any lead, human or agent (§6) |
| Deliberation | Lead "resolves disputes" | Explicit proposal → positions → decision flow with escalation ladder (§7) |
| Autonomy | "Full autonomy, pull back later" with no mechanism | Pause, revoke, freeze, budgets, risk tiers, per-capability approval gates built into the protocol from day one (§22) |
| Latency | "Between Git and Google Docs" | Quantified NFRs: ChangeSet visible to all in p95 < 500 ms (§3) |
| Workspace storage | Object storage + PostgreSQL, unspecified | Git used internally as the storage and merge engine, never exposed in APIs (§9) |
| Merge semantics | "Overlapping" undefined | Hunk-level three-way merge, atomic ChangeSets, conflicts are always "ChangeSet vs. current head" (§10–11) |
| Semantic breakage | Unaddressed | Asynchronous workspace health checks on every head; checkpoints gated on green (§12) |
| Human editing | Unaddressed | Editor buffers are drafts flushed as ChangeSets within seconds; client-side rebase (§13) |
| Sandbox ↔ workspace | "Generate candidate file changes" | Working-copy model with explicit sync and submit, behind-head notifications (§14) |
| Agent onboarding | Unaddressed | Invite tokens, agent manifests, room-scoped credentials; **MCP is the primary MVP path** (§15) |
| Agent attention | Firehose subscription | Filtered subscriptions, per-participant inbox, deterministic digests, wake-up webhooks (§17) |
| Tasks | Missing assign/release/cancel, no leases | Full lifecycle with atomic claims, leases, review rules (§8) |
| Memory | No concurrency control | Compare-and-set writes, namespaces, history (§18) |
| Event ledger | Mechanics unspecified | Single writer per room, gap-free sequences, idempotency keys, redaction (§19) |
| Security | Capabilities only | Threat model, OPA policy engine, secrets vault, sandbox egress control, provenance labels (§21, §23) |
| Git | Export only | Upstream sync, checkpoint attribution, PR-based export (§24) |
| Room lifetime | "Temporary" vs. "persistent history" contradiction | Rooms are bounded projects whose history persists after archive (§5) |
| Phase alignment | MCP/A2A listed in both MVP stack and Phase 2 | MCP in Phase 1, A2A in Phase 2 (§32) |

## 0.2 Decision log

| # | Decision | Reasoning | Alternative rejected |
|---|---|---|---|
| D1 | Git (bare repo per room) is the internal storage and merge engine | Gives content-addressed storage, three-way merge (`git merge-tree`), history and diffs for free; commits take milliseconds, so it doesn't threaten latency targets. APIs stay Git-agnostic so the Workspace Change Graph can replace it | Custom blob store + custom merge in v1 (months of work before the first demo) |
| D2 | A conflict is always "one ChangeSet vs. current head", never "A vs. B" | Handles any number of concurrent writers uniformly; canonical never contains conflict markers and never stops moving | Pairwise conflict objects (break down at three or more writers) |
| D3 | The submitter resolves first, then the lead, then the owner | The submitter has the most context and the cheapest fix is a rebase; the lead only sees genuinely hard conflicts | Lead resolves every conflict (lead becomes a bottleneck) |
| D4 | Semantic validation is asynchronous and non-blocking | Blocking every ChangeSet on tests would make the p95 < 500 ms target impossible | Synchronous CI gate per ChangeSet |
| D5 | Single writer per room (room actor with ownership lease) | Gives a total order, gap-free sequences and serialized merges without distributed locking | Multi-writer with optimistic retries |
| D6 | Agents work in a server-side sandbox working copy exposed through standard coding tools | Existing coding agents expect a filesystem and a shell; this gives them one while keeping Model A (server-side workspace) | Raw REST file API only (poor fit for real coding agents) |
| D7 | MCP server is the primary MVP agent interface | Claude Code, Codex, Cursor and most agent frameworks already speak MCP; it's the shortest path to "external agents join a room" | CLI-first (forces every agent to learn a new tool) |
| D8 | Room Owner is always human and cannot be held by an agent | Preserves the human supervision you asked for (Q11) even when an agent is lead | Lead as sole authority |
| D9 | OPA (embedded via WASM) evaluates every authorization decision | Capabilities are already policy-shaped; policy-as-code makes every grant and denial auditable and testable | Hand-rolled permission checks |
| D10 | Plugins run server-side in a Plugin Runner; agents never see credentials | Prompt-injected agents can't leak what they never hold | Credentials injected into agent sandboxes |
| D11 | Sandboxes use Docker with the gVisor runtime on dedicated hosts | Cheap, meaningful isolation upgrade over plain Docker without Firecracker's operational cost | Plain Docker on app hosts |
| D12 | Agent CLI in Go; agent SDKs in TypeScript and Python | Go ships as one static binary agents can install anywhere; Python is where agent frameworks live | TypeScript CLI (requires Node on the agent's host) |
| D13 | Human editor flushes drafts after 1.5 s idle | Small, frequent ChangeSets keep human conflicts tiny and make the workspace feel live without CRDTs | Save-only flushing (large, conflict-prone ChangeSets) |
| D14 | Tier 3 (irreversible / production) capabilities are never in default bundles and expire within 24 h | Full autonomy stays the default for everything that can be undone | Approval prompts for everything (contradicts Q4) |

---

# 1. Product Vision

Build a **real-time multiplayer development environment where humans and autonomous agents collaborate as first-class project participants over a shared room, workspace, task state, memory, and execution environment**.

The product is not simply:
- chat with agents,
- Slack with bots,
- a multi-agent orchestrator,
- or a conventional IDE.

It combines:
- collaboration,
- shared project state,
- shared source artifacts,
- task coordination,
- agent interoperability,
- isolated execution,
- and eventually a new low-latency source-control model.

The initial target user is a developer collaborating directly with external coding agents. The architecture should later generalize to broader multi-agent teamwork.

---

# 2. Core Principles

## 2.1 The Room is the primary collaboration unit

A **Room** is a bounded project environment containing humans and agents. It has a lifecycle (§5): it is active while the project runs, and its history persists after it is archived.

Agents are room-scoped for the MVP rather than persistent identities reused across projects.

## 2.2 Humans and agents are different client types

Humans get a rich GUI. Agents get machine-optimized interfaces (MCP, CLI, REST, WebSocket, SDK; A2A later). Both operate on the same authoritative server-side room state.

## 2.3 Chat is not the database

Messages are one category of room event. Authoritative project state includes participants, roles, capabilities, tasks, decisions, memory, workspace revisions, conflicts, sandbox activity, plugin activity, and room events.

## 2.4 No inferred project structure

The platform never infers tasks, decisions, ownership, completion, or mentions from conversation. Every structural change is an explicit command.

## 2.5 Canonical server-side workspace

The canonical workspace is the source of truth for every participant. Editor buffers and sandbox working copies are explicitly marked as non-authoritative drafts.

## 2.6 Full autonomy with explicit authorization

Agents act without approval prompts within their granted capabilities. Full autonomy never means unlimited permissions.

## 2.7 Humans own the room

Every room has exactly one human **Room Owner** whose authority sits above any project role. An agent may lead the project; it may never own the room.

## 2.8 Every agent action is attributable and revocable

Every mutation records its actor. Every capability can be revoked while the agent is working, and the revocation takes effect on the agent's next command.

## 2.9 Participant content is untrusted data

Content written by one participant is data, never instructions, for every other participant. The platform labels provenance; capabilities contain the blast radius.

---

# 3. Non-Functional Requirements (MVP)

"Between Git and Google Docs" is defined by these targets:

| Requirement | Target |
|---|---|
| ChangeSet submitted → applied → visible to all subscribers | p95 < 500 ms, p99 < 1 s (same region) |
| Human keystroke → visible to others as committed change | ≤ 3 s typical (1.5 s idle flush + apply + broadcast) |
| Presence / cursor update propagation | p95 < 150 ms |
| Merge time for a typical ChangeSet (≤ 20 files) | p95 < 50 ms |
| Sandbox cold start (warm image, repo ≤ 200 MB) | p95 < 10 s |
| Sandbox resume from hibernation | p95 < 3 s |
| Participants per room | ≤ 10 (≤ 8 agents) |
| Concurrent sandboxes per room | ≤ 10 |
| Repository size at import | ≤ 1 GB working tree, ≤ 50,000 files |
| Text-mergeable file size | ≤ 5 MB; larger files are binary blobs (§9.4) |
| Sustained event rate per room | 50 events/s |
| Availability | 99.5% (single AWS region) |
| Durability of applied ChangeSets | No loss of any acknowledged ChangeSet (RPO = 0 for metadata, seconds for repository objects with replica) |

---

# 4. High-Level Architecture

```text
                              COLLABORATION ROOM

  Human Client                                              Agent Clients
  Web (React)                                      MCP / CLI / REST / WS / SDK
       │                                                         │
       └──────────────────┐                   ┌──────────────────┘
                          ▼                   ▼
                 ┌──────────────────────────────────┐
                 │        Realtime Gateway          │  stateless, WS + REST
                 │  auth · routing · fan-out        │
                 └───────────────┬──────────────────┘
                                 │ routes commands to room owner node
                 ┌───────────────▼──────────────────┐
                 │       ROOM KERNEL (room actor)   │  single writer per room
                 │                                  │
                 │ Participants / Authority / Roles │
                 │ Policy (OPA)                     │
                 │ Messages · Tasks · Decisions     │
                 │ Memory · Inbox · Presence        │
                 │ Event Ledger                     │
                 └──────┬──────────┬───────────┬────┘
                        │          │           │
          ┌─────────────┘          │           └──────────────┐
          ▼                        ▼                          ▼
  WORKSPACE SERVICE         EXECUTION SERVICE            PLUGIN RUNNER
  bare Git repo per room    sandbox orchestration        MCP servers / plugins
  apply pipeline / merge    working-copy sync            credential injection
  conflicts / health        exec / logs                  (agents never see secrets)
  search index / checkpoint
          │                        │                          │
          ▼                        ▼                          ▼
  EBS (repo) + S3           Sandbox hosts                Secrets Manager
  PostgreSQL (metadata)     Docker + gVisor              STS / GitHub App
```

## 4.1 Deployment

Start as a **modular monolith**:

- **App nodes** run the gateway, room kernel, workspace service and plugin runner as modules in one TypeScript/Node process (plugin runner child processes are isolated per invocation).
- **Sandbox hosts** are separate EC2 instances. They are a hard security boundary and never share a host with app nodes.
- **Shared infrastructure:** PostgreSQL (RDS), Redis (ElastiCache), S3, Secrets Manager.

Logical module boundaries are explicit in code (separate packages with interface contracts) so subsystems can be split into services later.

## 4.2 Room affinity (single writer)

Each active room is owned by exactly one app node at a time.

- Ownership is a row in `room_leases` (room_id, node_id, fencing_token, expires_at), renewed every 5 s with a 15 s expiry.
- The gateway routes all mutating commands for a room to its owner node; reads may be served from any node via PostgreSQL.
- On owner failure, another node acquires the lease with an incremented fencing token. Every write the room actor performs carries the fencing token; writes with a stale token are rejected by a PostgreSQL check, so a "zombie" owner cannot corrupt state.
- The room's bare Git repository lives on the owner node's EBS volume, with an async replica on a standby node (§9.2). On failover, the new owner attaches from the replica and reconciles against PostgreSQL (§19.4).

---

# 5. Room Lifecycle

```text
ACTIVE ──freeze──▶ PAUSED ──resume──▶ ACTIVE
  │                  │
  └──archive──▶ ARCHIVED ──(30-day grace)──▶ DELETED
                  │
                  └──export bundle
```

| State | Behavior |
|---|---|
| `ACTIVE` | Normal operation |
| `PAUSED` | Owner froze the room. All agent mutations rejected with `ROOM_PAUSED`; agent sandboxes stopped (volumes kept); humans can read, owner can still act |
| `ARCHIVED` | Read-only. Sandboxes destroyed. Repository, ledger, memory, tasks and decisions retained (default 1 year). Exportable as a bundle |
| `DELETED` | Hard-deleted after a 30-day grace period from the delete request |

- **Archive triggers:** owner action, or 30 days with no mutations (owner notified 7 days before).
- **Export bundle:** `git bundle` of the full repository + `events.jsonl` + `memory.json` + `tasks.json` + `decisions.json`.
- This resolves the v0.1 tension: rooms are bounded projects (agents and sandboxes live and die with them), but their history persists.

Room schema:

```text
Room
  id
  slug
  name
  objective
  status            ACTIVE | PAUSED | ARCHIVED | DELETED
  owner_id          human participant
  lead_participant_id
  workspace_id
  settings          health_command, review_required_default, egress_allowlist, budgets
  last_sequence
  created_at
  archived_at
```

---

# 6. Participants, Authority, and Roles

## 6.1 Two orthogonal layers

**Authority layer** (who governs the room):

| Authority | Held by | Count |
|---|---|---|
| Owner | Human only | Exactly 1 |
| Admin | Human only | 0..n |
| Member | Human or agent | 0..n |

**Project role layer** (how work is organized):

| Role | Count | Default capability bundle |
|---|---|---|
| Lead | Exactly 1 | Developer bundle + task assign/cancel/reopen, conflict resolve, decision decide, review, checkpoint create, decide held ChangeSets (§22.4) |
| Developer | 0..n | messages, tasks (claim/update own), workspace read/write, conflict abandon (submitter only), memory read/write, sandbox exec, decisions propose |
| Reviewer | 0..n | Read everything, messages, tasks review, conflict abandon (submitter only), decisions propose, memory write |
| Observer | 0..n | Read everything except sandbox output (Owner/Admin authority can view it); no mutations other than presence |

A participant has one authority level and one project role. Example: Peter = Owner + Developer while ArchitectAgent = Member + Lead.

## 6.2 Owner and admin powers

The owner (and admins, except where noted) can:

- invite and remove participants,
- grant and revoke capabilities beyond role defaults (Tier 3 grants: owner only),
- appoint or replace the lead,
- pause, resume or remove any agent,
- freeze, resume, archive the room (owner only),
- override any lead decision (veto, §7.3),
- abandon any workspace conflict as room owner, regardless of project role (§11.3),
- set budgets and the sandbox egress allowlist,
- decide held ChangeSets as room owner; admins alone cannot (§22.4),
- set protected workspace paths (§22.4; owner only),
- redact events (§19.6),
- read non-secret integration configuration (admins only),
- connect and disconnect room integrations (owner only).

## 6.3 Limits on an agent lead

An agent holding Lead **cannot**:

- grant capabilities it does not itself hold, or any Tier 3 capability,
- remove or change the role of a human participant,
- change the owner or admins,
- un-pause a participant paused by a human,
- override a human owner's veto.

## 6.4 Lead transfer

- The owner appoints a lead at any time (`room.set_lead`).
- The current lead may hand off (`room.transfer_lead`); the recipient must accept within 10 minutes.
- If an **agent** lead is disconnected for more than 10 minutes, lead reverts to the owner automatically (`lead.changed`, reason `lead_unavailable`). Human leads do not auto-revert.

## 6.5 Participant schema

```text
Participant
  id
  room_id
  kind               HUMAN | AGENT
  display_name
  authority          OWNER | ADMIN | MEMBER
  role               LEAD | DEVELOPER | REVIEWER | OBSERVER
  status             INVITED | ACTIVE | PAUSED | REMOVED
  capability_grants  [] (beyond role defaults, see §21)
  budgets            overrides of room defaults (§22.3)
  agent_manifest     (agents only, §15.2)
  user_id            (humans only, platform account)
  joined_at
  last_seen_at
```

---

# 7. Deliberation and Decisions

You asked that the lead deliberate, as in a real project. Deliberation is an explicit object, not a chat convention.

## 7.1 Decision lifecycle

```text
PROPOSED ──▶ ACCEPTED ──▶ SUPERSEDED
    │
    ├──────▶ REJECTED
    │
    └──────▶ WITHDRAWN (by proposer)

ACCEPTED/REJECTED ──(owner veto within 24 h)──▶ VETOED
```

1. **Propose.** Any participant with `decisions.propose` opens a decision with context and options.
2. **Positions.** Participants add positions: a chosen option plus argument. Positions are structured, so an agent lead can read all arguments without parsing chat.
3. **Decide.** The lead accepts one option (or rejects the proposal) with a written rationale. The lead may set a `decide_by` deadline when proposing or after.
4. **Veto.** The owner may veto an accepted or rejected decision within 24 hours; the decision moves to `VETOED` and the owner's rationale is recorded. The owner may then decide directly.
5. **Supersede.** A later accepted decision can supersede an earlier one; the old one moves to `SUPERSEDED` with a link.

## 7.2 Decision schema

```text
Decision
  id
  room_id
  title
  context              markdown
  options[]            { id, summary, detail }
  positions[]          { participant_id, option_id, argument, created_at }
  status
  outcome_option_id
  rationale
  proposed_by
  decided_by
  vetoed_by
  decide_by
  links[]              task / changeset / conflict / memory key / file@revision
  supersedes           decision id
  version              (optimistic concurrency)
  created_at
  decided_at
```

## 7.3 Escalation ladder

Disputes of every kind (task ownership, review disagreements, conflicts, design choices) follow the same ladder:

```text
participants discuss ──▶ lead decides ──▶ owner may veto / decide
```

Workspace conflicts have their own fast path in front of this ladder (§11.3).

## 7.4 Decisions vs. memory

- A **Decision** is a choice made with authority and rationale. It answers "what did we decide, who decided, and why?"
- A **Memory entry** is knowledge any participant can write. It answers "what do we know?"
- Accepted decisions are mirrored automatically into the reserved, read-only memory namespace `decisions/<decision-id>` so agents that read memory see them. This is a deterministic projection, not inference.

---

# 8. Task System

Task creation and management are explicit. No task is generated from chat.

## 8.1 Task schema

| Field | Purpose |
|---|---|
| `id` | Stable identifier |
| `room_id` | Owning room |
| `title` | Short task name |
| `description` | Full task explanation |
| `requirements` | Explicit completion criteria (list) |
| `owner_id` | Assigned human or agent (null when OPEN) |
| `created_by` | Creator |
| `status` | Lifecycle state (§8.2) |
| `priority` | Optional ordering (P0–P3) |
| `dependencies` | Other task IDs |
| `artifacts` | Related files / ChangeSets |
| `reviewer_id` | Optional reviewer (defaults to lead) |
| `review_required` | If false, submitting goes straight to DONE (default from room settings: true) |
| `blocked_reason` | Required when BLOCKED |
| `lease_expires_at` | Agent claim lease (§8.4) |
| `reviews[]` | `{ reviewer_id, verdict, comments, revision, created_at }` |
| `version` | Optimistic concurrency |
| `created_at` / `updated_at` | Audit timestamps |

## 8.2 Lifecycle

```text
           assign / claim
   OPEN ─────────────────▶ CLAIMED ──start──▶ IN_PROGRESS ◀──▶ BLOCKED
    ▲                        │                    │
    │  release / lease expiry│                    │ submit
    └────────────────────────┴────────────────────┤
                                                  ▼
                       request_changes ◀──── REVIEW ──approve──▶ DONE
                       (back to IN_PROGRESS)                       │
                                                                   │ reopen (lead)
                                                                   ▼
                                                              IN_PROGRESS

   Any non-DONE state ──cancel (lead/owner)──▶ CANCELLED
```

| Transition | Command | Who |
|---|---|---|
| OPEN → CLAIMED | `tasks.claim` | Any participant with `tasks.claim` |
| OPEN → CLAIMED | `tasks.assign` | Lead, owner, admin |
| CLAIMED → IN_PROGRESS | `tasks.start` | Task owner; requires all dependencies DONE unless lead sets `override_dependencies` |
| IN_PROGRESS ↔ BLOCKED | `tasks.block` / `tasks.unblock` | Task owner, lead |
| IN_PROGRESS → REVIEW | `tasks.submit` | Task owner (→ DONE directly if `review_required=false`) |
| REVIEW → DONE | `tasks.review(approve)` | Reviewer or lead; requires workspace health green at the reviewed revision unless lead overrides (§12) |
| REVIEW → IN_PROGRESS | `tasks.review(request_changes)` | Reviewer or lead |
| CLAIMED/IN_PROGRESS/BLOCKED → OPEN | `tasks.release` | Task owner, lead; or automatic lease expiry |
| DONE → IN_PROGRESS | `tasks.reopen` | Lead, owner |
| any non-DONE → CANCELLED | `tasks.cancel` | Lead, owner |

A participant cannot approve a task they own.

## 8.3 Atomic claims and updates

- `tasks.claim` is a conditional update (`WHERE status = 'OPEN' AND version = $v`). Exactly one claimant wins; others receive `CONFLICT_VERSION` with the current task.
- All task updates take `expected_version`.

## 8.4 Claim leases (agents only)

- An agent's claim carries a 15-minute lease, renewed by any command the agent makes that references the task (ChangeSet with `task_id`, task update, message with the task in `refs`) or by `tasks.heartbeat`.
- If the lease expires **and** the agent is disconnected, the task returns to OPEN (`task.lease_expired`) and the lead is notified through the inbox.
- Human claims do not expire; the lead may reassign.

---

# 9. Canonical Workspace

The workspace is server-side and authoritative. Participants change it only through ChangeSets.

## 9.1 Storage engine (D1)

Each room has a **bare Git repository** used purely as an internal storage and merge engine:

- Each applied ChangeSet becomes one commit on the internal ref `refs/room/canonical`.
- **PostgreSQL is the source of truth for the head.** The table `workspace_revisions(revision, commit_sha, changeset_id, created_at)` maps a monotonically increasing integer **workspace revision** to a commit. The Git ref is a cache of the latest row (§19.4).
- **File revisions** are per-path integers in `file_revisions(path, revision, workspace_revision, blob_sha, actor_id)`, incremented whenever that path changes.
- No Git concepts (SHAs, branches, refs) appear in the public API. Clients see workspace revisions and file revisions only.

The Git CLI (≥ 2.38) runs on the workspace node. `git merge-tree --write-tree` performs three-way merges in memory without a worktree.

## 9.2 Durability

- Primary repository on the owner node's EBS volume.
- After each commit, an async `git push` to a replica bare repository on a standby node (lag target < 2 s).
- Hourly incremental `git bundle` to S3; full bundle daily.
- If the primary and replica both fail, the repository is rebuilt from the latest S3 bundle plus ChangeSet payloads stored in PostgreSQL/S3 since that bundle. Every acknowledged ChangeSet's payload is persisted before acknowledgment, which is what makes RPO = 0 hold.

## 9.3 Ignore rules

- The repository's `.gitignore` files are honored, plus an optional `.roomignore` at the root.
- Ignored paths never enter ChangeSets. Sandboxes keep `node_modules`, build output, caches and other generated files locally.

## 9.4 Large and binary files

- Files over 5 MB, or detected as binary, are stored as blobs in S3 and referenced by pointer in the repository (Git LFS-compatible pointer format).
- They are never text-merged. Any concurrent modification of the same binary path is a conflict.
- Upstream repositories using Git LFS keep their pointers unchanged.

## 9.5 Search

The workspace node maintains a checked-out working tree of the canonical head (updated after every commit). `workspace.search` runs ripgrep against it, which is fast enough for repositories up to the NFR limit. A trigram index (e.g. Zoekt) is a Phase 2 upgrade for larger repositories.

## 9.6 File operations (read side)

```text
workspace.list        path, revision?
workspace.read        path, revision?   → content + file_revision + workspace_revision
workspace.search      query, glob?, revision? (head only in MVP)
workspace.diff        from_revision, to_revision, paths?
workspace.history     path? , limit, before?
workspace.blame       path, revision?
```

All writes go through `workspace.apply_changeset` (§10). Create, modify, rename and delete are operations inside a ChangeSet, not separate endpoints.

---

# 10. ChangeSets and the Apply Pipeline

## 10.1 ChangeSet schema

```text
ChangeSet
  id
  workspace_id
  actor_id
  idempotency_key
  source                 EDITOR | SANDBOX | API | UPSTREAM | RESOLUTION
  task_id                optional
  conflict_id            set when resolving a conflict
  message                short description

  base_workspace_revision
  base_file_revisions    { path: file_revision }

  operations[]
    create   path, content | blob_ref
    modify   path, patch (unified diff) | content
    rename   from, to, (optional modify of content)
    delete   path

  status                 PENDING | APPLIED | CONFLICT | REJECTED
  rejection_reason
  applied_revision
  created_at
  applied_at
```

Limits: ≤ 500 operations and ≤ 25 MB of text per ChangeSet.

## 10.2 Guarantees

- **Atomic.** A ChangeSet applies completely or not at all. If any file conflicts, nothing is applied.
- **Serialized.** The room's workspace queue applies ChangeSets one at a time in arrival order (D5).
- **Idempotent.** Resubmitting with the same `idempotency_key` returns the original result.

## 10.3 Apply algorithm

```text
1. Authorize       actor holds workspace.write for every touched path (path scopes, §21)
2. Validate        paths normalized, not ignored, within size limits;
                   secret scan (§23.3); circuit breakers (§22.4)
3. Persist payload ChangeSet row + payload stored before processing (durability)
4. Materialize     build a commit C = base_commit + operations
5. Merge
     if base_revision == head:      fast-forward, result = C
     else:                          git merge-tree --write-tree base_commit head_commit C
6. Classify
     clean merge                    → step 7
     content or structural conflict → status CONFLICT, create Conflict (§11), stop
7. Parse check     for supported source files changed by the merge, if the merged result fails
                   to parse in a file where neither side's version failed → treat as CONFLICT
                   (source=EDITOR drafts that already fail to parse are allowed through);
                   skip files over 1 MiB and stop after 8 MiB of unique source has been parsed
8. Commit          commit-tree → PostgreSQL txn: workspace_revisions row, file_revisions rows,
                   ChangeSet APPLIED, event workspace.changeset.applied → update Git ref
9. Respond         { status: APPLIED, applied_revision }
10. Async          health check scheduling (§12), search tree update, replica push
```

## 10.4 What counts as overlapping

The merge uses Git's diff3 semantics at hunk level:

- **Content conflict:** both sides change the same lines, or change lines that are directly adjacent (no unchanged line between the hunks). This is deliberately conservative.
- **Structural conflicts:**
  - modify vs. delete of the same path,
  - rename vs. rename of the same path to different targets,
  - rename vs. modify where the rename target already exists,
  - add vs. add of the same path with different content,
  - any concurrent modification of a binary path.

Renames are explicit operations, so rename detection never relies on heuristics.

---

# 11. Conflicts

## 11.1 Model (D2)

A conflict is always between **one ChangeSet and the current head**. Canonical never contains conflict markers and keeps advancing while a conflict is open. Files are never frozen.

```text
Conflict
  id
  workspace_id
  changeset_id                 the ChangeSet that could not apply
  submitter_id
  base_revision
  head_revision_at_detection
  files[]
    path
    kind                       CONTENT | MODIFY_DELETE | RENAME | ADD_ADD | BINARY | PARSE
    hunks[]                    { base, ours (submitter), theirs (head), line ranges }
  counterparty_changesets[]    applied ChangeSets between base and head that touched
                               the conflicting regions (for attribution and pinging)
  status                       OPEN | ESCALATED | RESOLVED | ABANDONED
  attempts                     number of failed resolution submissions
  resolver_id
  resolution_changeset_id
  created_at
  escalated_at
  resolved_at
```

## 11.2 Why this handles many writers

Peter, Agent A and Agent C all editing `auth.ts` produces at most one open conflict per ChangeSet that lost the race, each against whatever head existed when it was applied. No pairwise bookkeeping is needed.

## 11.3 Resolution ladder (D3)

```text
1. SUBMITTER  (window: 10 min for agents, no limit for humans)
     - receives targeted inbox item + conflict payload
     - submits a RESOLUTION ChangeSet based on the current head
     - may ping counterparties in the room channel (refs → conflict)
           │
           │ 2 failed attempts, window expires, or submitter calls conflicts.escalate
           ▼
2. LEAD
     - resolves with a RESOLUTION ChangeSet, or abandons the ChangeSet
           │
           │ lead is the submitter, or a human disputes the resolution
           ▼
3. OWNER     final say
```

- A resolution ChangeSet is a normal ChangeSet. If the head moved again and it conflicts, the same conflict stays open and `attempts` increments.
- `conflicts.abandon` discards the original ChangeSet (submitter, lead or owner).
- Human submitters resolve in the editor's merge view (§13.3).

## 11.4 Reducing conflicts: edit intents

Participants can publish advisory **edit intents** (`presence.set_intent { paths, ranges?, task_id? }`). Intents appear in presence and in agents' `sandbox.behind` notifications. They are advisory only and never block writes; they let agents choose not to touch a region someone else is about to change.

---

# 12. Workspace Health (Semantic Validation)

Edits that don't overlap can still break the build (Peter renames a function while Agent B adds a call to the old name). Health checks catch this without blocking ChangeSets (D4).

## 12.1 Mechanism

- The room has a configurable `health_command` (e.g. `npm run typecheck && npm test`), set by the lead or owner. Default: none until configured; the import flow suggests one based on the repository. `health_image` is also configurable by the lead or owner and defaults to `node:22-bookworm-slim`; the operator's `HEALTH_IMAGES` allowlist controls which images rooms may select.
- A dedicated **system health sandbox** runs the command against each new head in a no-network, non-root Docker container with a read-only checkout, resource limits, and a 10-minute timeout.
- When `health_install_command` is configured, a separate unprivileged install container prepares a per-room Docker dependency cache. It receives egress only on an ephemeral internal Docker network attached to the platform proxy; the proxy requires a per-run HMAC identity recorded as `RUNNING` and applies the platform registry defaults plus `settings.egress_allowlist`. The run identity expires and its status ends before the network is removed. The health sandbox mounts the cache read-only and remains on `--network=none`.
- `health_lockfile_paths` optionally selects up to 10 normalized relative paths for cache invalidation. It defaults to `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`, and `go.sum`; absent paths are ignored. Changing the lockfile content, image, or install command rebuilds the cache.
- **Coalescing:** at most one run in progress and one queued. A queued run always targets the latest head, so bursts of ChangeSets produce few runs.
- Each run emits `workspace.health` with `{ revision, status: GREEN | RED | ERROR, duration, log_ref, last_green_revision? }`. The event carries **no log text**: logs routinely name files a path-scoped participant may not see, and can echo secrets, and the ledger is room-wide and permanent (§34.5). The failing summary and log tail are read through `workspace.health.get { run_id }`, which is limited to participants with unscoped `workspace.read`. Scoped participants see the status only.
- On RED, the event identifies the last GREEN revision, giving the range of suspect ChangeSets. Authors of ChangeSets in that range receive an inbox item.

## 12.2 Effects of health status

| Action | Requirement |
|---|---|
| ChangeSet apply | None (never blocked by health) |
| Task REVIEW → DONE | Health GREEN at a revision that includes the task's artifacts (lead may override) |
| Checkpoint export (§24) | Head GREEN (owner may override) |
| UI | Health badge in the room header, red range highlighted in history |

---

# 13. Human Editor Model

## 13.1 Drafts

- A Monaco buffer is a **draft**: local and non-authoritative. The UI shows a draft indicator on files with unflushed edits.
- Each buffer tracks its `base_file_revision`.

## 13.2 Flushing (D13)

A draft is flushed as a ChangeSet (`source = EDITOR`) when any of these happen:

- 1.5 s with no typing,
- 10 s of continuous typing,
- explicit save,
- switching files or closing the tab.

Flushes are small, so human conflicts are small.

## 13.3 Incoming changes to an open file

When `workspace.changeset.applied` touches a file open in the editor:

| Buffer state | Behavior |
|---|---|
| Clean (no unflushed edits) | Replace content; map cursor and selections through the diff |
| Dirty | Client runs the same diff3 algorithm (base, buffer, new canonical) in the browser |
| → merges cleanly | Buffer silently rebased to the new base; cursor mapped |
| → conflicts | Buffer kept; banner "auth.ts changed underneath you"; the next flush returns a Conflict, which opens Monaco's three-way merge view |

## 13.4 Live presence

- Human cursors, selections and open files are broadcast through the presence channel (Redis, ephemeral, never in the ledger).
- Agent edit intents (§11.4) render as highlighted regions in the editor. Each participant has at most one room-scoped intent: `{ paths, ranges?, task_id? }`; ranges are `{ path, start_line, end_line }` with 1-based inclusive line numbers. Set replaces the intent and refreshes its 45-second Redis TTL; clear deletes it. `presence.list_intents` returns active intents with participant ID and expiry. Intents are never written to the event ledger.

---

# 14. Execution Architecture and Sandbox Sync

## 14.1 Model (D6)

Each participant that needs execution gets an isolated sandbox containing a **working copy** of the canonical workspace. For agents, the working copy is their filesystem: they read, edit and run commands there, then submit their changes.

```text
                       CANONICAL WORKSPACE (head = r42)
                                   │
            ┌──────────────────────┼──────────────────────┐
            ▼                      ▼                      ▼
     Peter sandbox           Agent A sandbox         Agent B sandbox
     base r42 (follows head) base r39 + local edits  base r42, clean
            │                      │
            │                      └── changes.submit ──▶ ChangeSet(base r39) ──▶ apply pipeline
            │
            └── terminal for tests / scripts
```

## 14.2 Working-copy state

Each sandbox tracks:

- `base_revision`: the canonical revision its working copy started from,
- local modifications relative to that base (computed with `git status`/`git diff` inside the sandbox; the sandbox clone is ordinary Git internally),
- ignored and generated files, which never leave the sandbox.

`sandbox.status` returns `{ base_revision, head_revision, behind_by, modified, added, deleted }`. `head_revision` is the latest canonical workspace revision; `behind_by` is the nonnegative difference from `base_revision`. File lists come from porcelain Git status with rename detection disabled, so a rename is reported as a deletion plus an addition. An isolated Git helper reads the sandbox volume with no network access and a read-only mount; `.gitignore` and `.roomignore` paths are omitted.

## 14.3 Materialization

- On first use (`sandbox.*` or a coding tool call through MCP), the Execution Service starts a container and materializes the workspace through a short-lived fetcher container. The fetcher alone joins the unpublished `crossover-git` Docker network, mounts the sandbox workspace, and reads from a separate internal Git listener on the workspace node. The server binds `GIT_INTERNAL_HOST` to its configured address on that private network; the deployment connects the server to the network before startup and never publishes `GIT_INTERNAL_PORT`.
- Each fetch carries an HMAC read token bound to the room, participant, sandbox, canonical workspace revision, and an expiry no more than five minutes away. The agent container never joins `crossover-git` and never receives the token. The listener accepts upload-pack only. For path-scoped readers it creates a deterministic synthetic root commit, packs only that commit's reachable objects, and serves it without canonical object alternates; for unscoped readers it packs the real canonical commit with a shallow boundary, excluding its parents and historical blobs. Advertisements skip packing; object negotiation always uses an isolated packed repository. Startup removes abandoned temporary snapshots older than a day.
- The bearer value is passed through the Docker CLI environment rather than its arguments. It remains in the short-lived fetcher's Docker `Config.Env`, visible to Docker administrators until that container is removed; it never enters the agent container.
- The fetcher uses the canonical per-room repository as a read-only clone reference. Its `repo_path` must be visible at the same source path to the Docker daemon that runs the fetcher. The clone is dissociated before it is copied into the sandbox volume, so the sandbox never retains that alternate.

## 14.4 Staying current

The sandbox never changes files underneath a running agent without warning.

- When canonical advances, the sandbox owner receives `sandbox.behind { behind_by, changed_paths, overlaps_local_changes, intents }`.
- **Auto-sync:** if the sandbox has no running process and none of the changed paths overlap local modifications, it fast-forwards automatically and emits `sandbox.synced`.
- **Explicit sync:** otherwise the agent calls `sandbox.sync`. The execution service runs a short-lived fetcher with a fresh revision-bound token, stashes local modifications as a temporary commit, fetches the new scoped or canonical snapshot, and rebases onto it.
  - Clean → returns `{ synced_to: r42 }`.
  - Conflicts → conflict markers are left in the affected files (the format coding agents already understand), and the call returns the conflicted paths. The agent fixes them and continues.
- **Human sandboxes** run in follow-head mode: they always auto-sync, because humans edit through the editor, not the sandbox.

## 14.5 Submitting

`changes.submit { paths?, message, task_id? }`:

1. The sandbox computes the diff between `base_revision` and the working tree (tracked + new non-ignored files; optional path filter).
2. It packages the diff as a ChangeSet with `base_workspace_revision = base_revision` and `source = SANDBOX`.
3. The apply pipeline (§10) processes it.
4. On APPLIED, the sandbox fast-forwards its base to the new revision. On CONFLICT, the agent receives the Conflict and typically runs `sandbox.sync` then resubmits.

Ignore rules come only from the canonical base tree. Snapshot bytes are read directly without Git filters or sandbox Git configuration, and every submitted path is authorized and revalidated by the apply pipeline. `paths` accepts exact normalized file paths or directory prefixes ending in `/`; globs are rejected, and each filter must match a changed path. An empty diff or filtered diff returns non-retryable VALIDATION `no_changes` without creating a ChangeSet, revision, or event. Selected added symlinks, changed symlink targets, and file/symlink type changes return VALIDATION `symlink_not_supported`; unselected symlinks are not read or submitted, and deleting a selected base symlink is allowed. New files use mode `100644`, modifications keep the base mode, and sandbox chmod changes are not submitted. Binary file contents are encoded as base64.

Tests run in a sandbox only validate that sandbox's view. Canonical truth comes from workspace health (§12).

## 14.6 Lifecycle and limits

| Setting | Default |
|---|---|
| Creation | Lazy, on first use |
| Hibernation | After 30 min idle: container stopped, volume kept |
| Volume retention | Until participant leaves or room is archived |
| CPU / memory / disk | 2 vCPU / 4 GB / 20 GB |
| Exec timeout | 10 min (owner may raise to 60) |
| Background processes | Allowed (dev servers); killed on hibernation |

## 14.7 Isolation (D11)

- Docker with the **gVisor (`runsc`)** runtime on dedicated sandbox hosts.
- **Network egress default-deny** through per-sandbox internal Docker networks. The separate non-root TypeScript proxy accepts HTTPS `CONNECT` on port 443 only, checks a sandbox-scoped credential and the room allowlist, resolves and pins public DNS answers, and emits structured per-sandbox byte logs. Egress to GitHub and registries is allowed; the platform supplies no credentials, so pushes and publishes need credentials the agent itself provides, which §21.4 discourages. The proxy logs uncaught exceptions and exits, and Docker runs it with `--restart unless-stopped`; an owner or admin uses `room.set_egress_allowlist { hosts }` to set up to 100 exact hosts or `*.suffix` patterns for the room. The normalized, deduplicated host list's canonical JSON is limited to 4 KiB so it fits the signed per-invocation plugin credential and proxy header. The setting applies to sandboxes; plugin tools use only the signed host list their invocation receives.
- Cloud metadata endpoints (IMDS) blocked.
- No platform or plugin credentials in sandboxes, ever (§21.4).
- One sandbox per participant; sandboxes cannot reach each other.

## 14.8 Output

- `sandbox.exec` stdout/stderr streams over a dedicated WebSocket channel (`sandbox.output`), not the event ledger.
- Output is stored in S3 as chunked log objects (30-day retention).
- The ledger records only `sandbox.exec.started { exec_id, participant_id }` and `sandbox.exec.finished { exec_id, participant_id, exit_code, duration_ms, log_ref }`; `participant_id` is whose sandbox ran it, so a `relevant` subscription (§17.1) delivers both to that participant.

## 14.9 Future execution options

Firecracker microVMs, Kubernetes scheduling, customer-hosted runners, local runners (Phase 2+).

---

# 15. Agent Onboarding and Identity

## 15.1 Joining a room

```text
Owner/admin                    Platform                         Agent operator
    │  room.invite(role, caps)    │                                   │
    │────────────────────────────▶│                                   │
    │  ◀── one-time join token ───│                                   │
    │      (expires 24 h)         │                                   │
    │── shares token ────────────────────────────────────────────────▶│
    │                             │  POST /v1/rooms/{id}/join         │
    │                             │  { token, manifest }              │
    │                             │◀──────────────────────────────────│
    │                             │── access token + refresh token ──▶│
    │  ◀── participant.joined ────│                                   │
```

- The join token encodes the intended role and capability bundle; it is single-use.
- Optionally the owner can require approval of the manifest before the agent becomes ACTIVE.

## 15.2 Agent manifest

```text
AgentManifest
  name                 display name in the room
  operator             person or org responsible, with contact
  vendor / model       self-declared (e.g. "Anthropic / claude-opus-…")
  client               mcp | cli | sdk-ts | sdk-python | rest | a2a
  client_version
  wake_webhook_url     optional (§17.4)
  description          what the agent is good at
```

Vendor and model are self-declared and displayed as such; they are not trusted for authorization.

## 15.3 Credentials

- **Opaque access tokens** (1 h) validated server-side on every command against Redis, plus refresh tokens (30 days, rotated on use). Opaque tokens make revocation immediate, which JWTs would not. `POST /v1/auth/refresh { refresh_token }` (no bearer header: the refresh token is the credential) spends a refresh token and returns a new access and refresh pair, the same shape as the join's `tokens`; presenting a spent one revokes the family. The route is limited per client address (`REFRESH_PER_MINUTE`, default 30; `RATE_LIMITED` with `Retry-After`; counted in Redis, and if that is down requests go ahead); IPv6 clients are limited by their /64. Behind reverse proxies set `TRUST_PROXY` to their addresses or CIDRs (comma-separated, default none): each hop is checked against the list from the server outwards and the client address is the first one that is not a listed proxy, so nothing a client writes to the left counts; without it everyone shares the proxy's address. A spent refresh token presented again within 30 s is taken for a retry after a lost response when it was the login's latest rotation and its successor was never used: the login gets a new pair and the unseen successor pair is revoked; anything else is reuse and revokes the login. The check runs under the login's advisory lock (a grace refresh and a normal rotation can't fork it), a spent token has one grace only, and a successor revoked by grace that is presented later means two holders and revokes the login. The SDK sends a refresh exactly once (never retried automatically) and surfaces a failure as retryable. The SDK renews an expired access token itself (T1106): on `UNAUTHENTICATED` a client holding the refresh token refreshes once however many calls and subscriptions noticed, retries the call with the same idempotency key, and hands each new pair to `onTokens` to persist (refresh tokens are single-use); a subscription whose token expired reconnects with the new one, losing no event.
- Removing or pausing a participant revokes its tokens and closes its WebSocket connections.
- Humans authenticate to the platform with GitHub or Google OAuth; room access comes from membership.

## 15.4 Interfaces by priority (D7)

| Priority | Interface | Who uses it |
|---|---|---|
| 1 | **MCP server** (remote streamable HTTP, or local stdio shim via `room mcp`) | Claude Code, Codex, Cursor, any MCP-capable agent |
| 2 | **CLI** (`room`, Go binary) | Shell-driven agents, scripts, humans in a terminal |
| 3 | **REST + WebSocket** | Custom agents |
| 4 | **SDKs** (TypeScript, Python) | Agent frameworks |
| Phase 2 | **A2A adapter** | Agent-to-agent interoperability |

The MCP server exposes two groups of tools:

- **Coding tools** that operate on the agent's sandbox working copy: `sandbox_status`, `sandbox_read_file`, `sandbox_write_file`, `sandbox_exec`, `sandbox_sync`, and `submit_changes`. The explicit `sandbox_` prefix keeps these separate from `read_file`, `list_dir` and `grep`, which read the committed canonical workspace. `sandbox_read_file` returns up to 1 MiB; `sandbox_write_file` accepts up to 512 KiB of decoded content. Use `sandbox_exec` for larger files. Sandbox writes stay local until `submit_changes` applies them as a ChangeSet.
- **Room tools** for collaboration: tasks, messages, memory, decisions, inbox, conflicts.

An agent connected through MCP therefore works almost exactly as it would on a local machine, except that its filesystem lives in the room's sandbox and its changes become ChangeSets.

---

# 16. Agent Protocol

The native Room Protocol models the collaboration domain directly. Every operation is available over REST, WebSocket, CLI, SDK and (where it makes sense) MCP.

## 16.1 Operations

```text
ROOM
  room.create              slug, name, objective (platform user, no room yet; creator becomes Owner)
  room.get_state           view=summary|full, paginated sections
  room.digest              since=sequence (§17.3)
  room.events.subscribe    filters (§17.1), after=sequence
  room.events.list         after, limit, types?
  room.set_egress_allowlist hosts (owner/admin; exact hosts or *.suffix, max 100; §14.7)
  room.set_protected_paths patterns (owner only; max 100; §22.4)
  events.redact            sequence, reason (owner only; §19.6)
  room.set_lead            owner/admin
  room.transfer_lead / room.accept_lead
  room.freeze / room.resume / room.archive          owner
  room.invite              owner/admin

PARTICIPANTS & PRESENCE
  participants.list / participants.get
  participants.set_role                              owner/admin (lead within limits, §6.3)
  participants.update_manifest                        self only, agents only (§34.6)
  participants.pause / participants.resume / participants.remove
  presence.update          status, open_files, cursor (humans)
  presence.set_intent      paths, ranges?, task_id?
  presence.clear_intent
  presence.list_intents

CAPABILITIES
  capabilities.list        participant_id
  capabilities.grant / capabilities.revoke
  approvals.list / approvals.decide / approvals.withdraw   (§22.2)

MESSAGES
  messages.list            before/after, limit
  messages.send            body, mentions[], refs[], reply_to?
  messages.edit            (author only; original kept in ledger)

INBOX
  inbox.list               unacked_only
  inbox.ack                ids[]

TASKS
  tasks.list / tasks.get
  tasks.create / tasks.update                        expected_version
  tasks.claim / tasks.assign / tasks.release
  tasks.start / tasks.block / tasks.unblock
  tasks.submit / tasks.review / tasks.reopen / tasks.cancel
  tasks.heartbeat

WORKSPACE
  workspace.list / workspace.read / workspace.search
  workspace.diff / workspace.history / workspace.blame
  workspace.apply_changeset
  workspace.changeset.get  status of a submitted ChangeSet
  workspace.changeset.decide_hold {changeset_id, decision, reason?}  lead or owner (§22.4)
  workspace.health.get     latest health per revision

CONFLICTS
  conflicts.list / conflicts.get
  conflicts.escalate / conflicts.abandon
  (resolution = workspace.apply_changeset with conflict_id)

SANDBOX
  sandbox.status / sandbox.file.read / sandbox.file.write
  sandbox.exec / sandbox.exec.cancel
  sandbox.sync / sandbox.reset (discard local changes)
  changes.submit / changes.diff (local, unsubmitted)

MEMORY
  memory.list / memory.get / memory.history
  memory.put               expected_revision
  memory.delete            expected_revision

DECISIONS
  decisions.list / decisions.get
  decisions.propose / decisions.add_position
  decisions.decide / decisions.withdraw / decisions.veto

TOOLS
  tools.list / tools.invoke

INTEGRATIONS
  integrations.connect / integrations.disconnect    room owner only
  integrations.verify                               room owner only
  integrations.list                                  participants; non-secret config for owner/admin

GIT
  git.import / git.pull_upstream
  checkpoints.create / checkpoints.list / checkpoints.export
```

## 16.2 Command envelope

Every mutating command carries:

```json
{
  "id": "cmd_01J…",
  "method": "tasks.claim",
  "params": { "task_id": "task_12", "expected_version": 3 },
  "idempotency_key": "agentA-7f3c…"
}
```

Idempotency keys are stored for 24 hours per participant. A duplicate returns the original response.

## 16.3 Error model

```json
{
  "error": {
    "code": "CONFLICT_VERSION",
    "message": "Task was updated by another participant",
    "retryable": true,
    "details": { "current": { … } }
  }
}
```

| Code | Meaning |
|---|---|
| `UNAUTHENTICATED` | Missing or invalid token |
| `FORBIDDEN` | Policy denied the action (details name the missing capability) |
| `NOT_FOUND` | Resource missing |
| `UNAVAILABLE` | A transient service or workspace helper failure; retry the request |
| `VALIDATION` | Malformed request |
| `CONFLICT_VERSION` | Optimistic concurrency failure (tasks, memory, decisions) |
| `CONFLICT_MERGE` | ChangeSet could not apply; details carry the Conflict id |
| `APPROVAL_REQUIRED` | Action queued for human approval (§22.2); details carry the approval id |
| `PARTICIPANT_PAUSED` / `ROOM_PAUSED` | Participant or room frozen |
| `RATE_LIMITED` / `BUDGET_EXCEEDED` | Throttled (§22.3); details carry retry-after |
| `CIRCUIT_BREAKER` | ChangeSet held for review (§22.4) |
| `PROVIDER_UNAVAILABLE` | A plugin's provider is down or timed out (§21.4); retryable unless the runner says not; the platform never retries a tool itself |

## 16.4 Versioning

REST paths are prefixed `/v1/`. WebSocket clients send `hello { protocol_version, client, client_version }`; the server replies with the negotiated version. Events carry `schema_version`. Breaking changes require a new major version with a 6-month overlap. Sandbox output uses the same cursor pattern as room events. A client subscribes with `sandbox.output.subscribe { exec_id, after }` and unsubscribes with `sandbox.output.unsubscribe { exec_id }`. The server replies `sandbox.output.subscribed { exec_id, after, last_sequence }`, then sends `sandbox.output { exec_id, sequence, stream, encoding: "base64", data }` chunks, followed by `sandbox.output.finished { exec_id, sequence, exit_code, duration_ms, reason, truncated }`. A truncation sentinel is `sandbox.output.truncated { exec_id, sequence }`. If a subscriber's 1 MiB buffer fills, the server drops queued output and sends `sandbox.output.resync_required { exec_id, after }`; the client subscribes again from that cursor. One socket may hold up to eight output subscriptions. Output is visible only to the sandbox participant, lead, room owner and admins, subject to the `sandbox.output` capability.

## 16.5 Provenance on every returned item

Every message, memory entry, decision position, task description and tool result returned to an agent carries:

```json
"provenance": { "author_id": "agent_4", "author_kind": "AGENT", "trust": "participant" }
```

`trust` is one of `system` (platform-generated), `participant` (written by a room member), or `external` (fetched from outside: web pages, GitHub issues, plugin output). SDKs and the MCP server render these labels so agents can tell data from platform instructions (§23.2).

## 16.6 Conceptual division

```text
A2A           → who agents talk to (Phase 2)
MCP           → what agents can use, and the primary way agents join (Phase 1)
Room Protocol → where collaboration lives
```

---

# 17. Agent Attention

Every event an agent reads costs it tokens and time. The platform tells agents what is relevant to them instead of streaming everything.

## 17.1 Filtered subscriptions

```text
room.events.subscribe {
  after: 9182,
  profile: "relevant" | "all" | "custom",
  types:   ["task.*", "workspace.conflict.*"],      (custom)
  scopes: {
    tasks:    "mine" | "all",
    files:    "touched" | ["src/auth/**"],
    mentions: true
  }
}
```

The default profile for agents is **`relevant`**: events where the agent is the target (assigned, mentioned, review requested, conflict on its ChangeSet, its task changed, its sandbox is behind), lead decisions, lead changes, room status changes, and health turning RED on a range that includes its ChangeSets.

T704: the subscriber says what it wants in the `subscribe` frame (and `room.events.subscribe`): `profile` (`relevant`, `all`, `custom`), and for `custom` `types` (patterns where `*` stays inside one dotted name: `task.*`, `workspace.conflict.*`) and `scopes` (`tasks: "mine" | "all"`; `mentions: true` also delivers messages that mention the subscriber whatever `types` says). Without a profile an agent gets `relevant` and a human `all`; `types` or `scopes` alone mean `custom`. `files` scopes aren't supported yet (`VALIDATION`). The `subscribed` frame carries the resolved `filter`. `relevant` delivers: room status changes, lead changes, lead decisions (`decided`, `vetoed`, `superseded`), messages that mention the agent, events that name the agent (assignments, its participant, capability and approval changes), changes to tasks it owns, conflicts and ChangeSet events on its own ChangeSets (and escalations, for the lead), its sandbox's events (behind, synced, command started and finished), and health turning RED where it is among the suspects (`suspect_ids`); its own denials. Sequence numbers stay the room's, so **a filtered stream has gaps by design**: what it delivers is in order and complete for the filter, each event once, and a reconnect resumes with `after` = the last sequence seen. The SDK doesn't treat a filtered stream's gaps as lost events. The viewer's redaction applies to whatever passes. The filter decides from the event alone, never the database; an event written before its type carried the field the filter needs is delivered (fail open).

## 17.2 Inbox

Each participant has an **inbox** of targeted items that require attention: assignments, review requests, mentions, conflicts, approvals, lease warnings, escalations, veto notices.

- Items persist until acknowledged (`inbox.ack`).
- An agent reconnecting after a gap checks its inbox first instead of replaying every event.

## 17.3 Deterministic digests

`room.digest { since }` returns a compact structured summary of everything since a sequence number: counts, new and changed tasks, applied ChangeSets with paths, open conflicts, decisions, memory keys changed, health status. It is generated deterministically from the ledger (no LLM), so it is cheap and reproducible.

## 17.4 Wake-up webhooks

Agents run elsewhere and may not hold a WebSocket open. If the manifest sets `wake_webhook_url`, the platform POSTs a signed (HMAC-SHA256) notification when a new inbox item arrives, rate-limited to one per agent per 30 s with batching.

T706: the body is `{ type: "inbox.wake", room_id, participant_id, count, items: [{ id, kind, ref }], more, sent_at }`: ids, kinds and refs only, never the items' text; the agent reads `inbox.list` for the rest. The first item after a quiet spell goes out at once; what arrives within the next 30 s is one batched delivery (up to 200 items; `more: true` says the rest follow in the next window). It is an outbox in PostgreSQL (`inbox_items.wake_notified_at`, `wake_windows`), so any number of nodes may run it, the 30 s limit holds across all of them and across restarts, and an item that commits late is still announced. Delivery is at least once. Items acknowledged before the send are left out; paused or removed agents, agents without a URL and frozen rooms are not called (their items wait). A failed delivery is retried after a window that doubles with each failure in a row (up to about an hour). Headers: `X-Crossover-Delivery` (unique id), `X-Crossover-Timestamp` (unix seconds) and `X-Crossover-Signature: sha256=<hex>`, where the hex is HMAC-SHA256 over `<timestamp>.<body>` keyed with the agent's secret. A receiver must compute the HMAC over the raw body, compare it in constant time, and reject a timestamp more than 5 minutes from its clock:

```js
const expected = "sha256=" + crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
const ok = Math.abs(Date.now() / 1000 - Number(ts)) < 300 &&
  expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
```

The agent reads its secret with `participants.wake_secret`; it is derived from the server's `WAKE_WEBHOOK_KEY` and the agent's id, so nothing is stored. The manifest URL must be `https` on the default port, without credentials, not `localhost` and not a private address literal; the POST goes only to a public host: the name is resolved once, every address must be public, the connection goes to that address, redirects aren't followed, and the whole exchange (DNS included) is bounded to 10 s and a small response size.

## 17.5 Mentions

Mentions are explicit: the client sends `mentions: [participant_id]` in `messages.send`. The server does not parse `@names` from message text (§2.4). Human clients convert `@` autocomplete selections into the array.

## 17.6 Loop protection

If two or more agents exchange more than 20 messages with no non-message state change (no task, ChangeSet, decision or memory mutation) in between, the platform throttles those agents' `messages.send` to one per minute and sends an inbox item to the lead and owner. Any non-message mutation resets the counter.

---

# 18. Shared Memory / Room Blackboard

Hidden model context windows are never shared. The room maintains four layers:

```text
1. EVENT HISTORY            everything that happened (ledger)
2. CURRENT ROOM STATE       participants, tasks, workspace revisions, …
3. SHARED MEMORY            explicitly written knowledge (this section)
4. PRIVATE AGENT CONTEXT    held by each agent outside the platform
```

## 18.1 Schema

```text
MemoryEntry
  key                 path-like, e.g. architecture/database
  value               text or JSON (≤ 64 KB; larger content goes in a workspace file + source_ref)
  content_type        text/markdown | application/json
  author_id
  revision            increments on every write
  created_at
  updated_at
  source_refs[]       task / decision / changeset / file@revision / message
  deleted             tombstone flag
```

## 18.2 Concurrency

- `memory.put` requires `expected_revision` (`0` to create). A mismatch returns `CONFLICT_VERSION` with the current entry, so concurrent writers never silently overwrite each other.
- `memory.delete` writes a tombstone; history is retained.
- `memory.history(key)` returns all revisions.

## 18.3 Namespaces

| Namespace | Writable by |
|---|---|
| `decisions/*` | System only (mirror of accepted decisions, §7.4) |
| `agents/<participant-id>/*` | That participant only (visible to all) |
| everything else | Any participant with `memory.write` |

## 18.4 Rules

- Writes are explicit; entries are revisioned.
- The blackboard is authoritative for shared knowledge; embeddings and vector search (Phase 2) are derived indexes and never authoritative.
- Private agent memory, chat history and canonical room state remain separate.

---

# 19. Event Ledger

## 19.1 Event schema

```json
{
  "sequence": 9182,
  "room_id": "room_123",
  "actor_id": "agent_4",
  "type": "workspace.changeset.applied",
  "schema_version": 1,
  "timestamp": "2026-10-03T21:04:11.482Z",
  "causation_id": "cmd_01J…",
  "payload": {},
  "payload_hash": "sha256:…",
  "redacted": false
}
```

## 19.2 Write path (D5)

```text
command ─▶ room actor (owner node)
             ├─ authorize (OPA)
             ├─ validate
             └─ PostgreSQL transaction
                  ├─ SELECT … FROM rooms WHERE id = $room FOR UPDATE   (+ fencing check)
                  ├─ write state rows (task, memory, …)
                  ├─ INSERT event with sequence = last_sequence + 1
                  └─ UPDATE rooms SET last_sequence = last_sequence + 1
             commit
             └─ publish event to Redis channel room:{id}
```

- Because one actor writes each room inside one transaction, sequences are **gap-free** and totally ordered.
- **The event table is the outbox.** If the Redis publish fails or a gateway misses a message, gateways detect a sequence gap and backfill from PostgreSQL. Clients do the same with `room.events.list?after=`.

## 19.3 What goes in the ledger

**In:** every meaningful state change (catalog below).
**Out:** presence, cursors, typing, edit intents, sandbox output streams. These are ephemeral (Redis) or stored separately (S3 logs).

## 19.4 Workspace and ledger consistency

A ChangeSet touches both Git and PostgreSQL:

1. Write Git objects (`merge-tree`, `commit-tree`). Unreferenced objects are harmless.
2. Commit the PostgreSQL transaction (revision row + event).
3. Update the Git ref.

If the node crashes between steps 2 and 3, the new owner reconciles on startup by setting the ref to the commit of the latest `workspace_revisions` row. PostgreSQL always wins.

## 19.5 Event catalog

```text
room.created / room.paused / room.resumed / room.archived
room.egress_allowlist_changed / room.protected_paths_changed
lead.changed / lead.transfer_offered

participant.invited / participant.joined / participant.left
participant.role_changed / participant.manifest_changed / participant.paused / participant.resumed / participant.removed

capability.granted / capability.revoked / capability.denied
approval.requested / approval.decided

message.sent / message.edited

task.created / task.updated / task.claimed / task.assigned / task.released
task.started / task.blocked / task.unblocked / task.submitted
task.reviewed / task.reopened / task.cancelled / task.lease_expired

decision.proposed / decision.position_added / decision.decided
decision.withdrawn / decision.vetoed / decision.superseded

memory.updated / memory.deleted

workspace.changeset.applied / workspace.changeset.rejected
workspace.changeset.held / workspace.changeset.hold_decided
workspace.conflict.created / workspace.conflict.escalated
workspace.conflict.resolved / workspace.conflict.abandoned
workspace.health
workspace.upstream_synced

checkpoint.created / checkpoint.exported

sandbox.created / sandbox.behind / sandbox.hibernated / sandbox.synced
sandbox.exec.started / sandbox.exec.finished

tool.invoked / tool.completed / tool.failed

integration.connected / integration.disconnected

budget.exceeded / circuit_breaker.tripped / loop.detected
event.redacted
```

## 19.6 Redaction

The ledger is immutable in structure, but payloads can be redacted:

- The owner can redact any event's payload (e.g. a pasted secret). The payload is replaced with a tombstone, `redacted = true`, and an `event.redacted` event records who, when and why. `payload_hash` is kept for audit.
- Redaction reaches the copies a reader can still fetch (T906): a redacted `message.sent`/`message.edited` blanks the message row (`messages.list` returns `redacted: true` and no body), tombstones every event of that message and the `MENTION` inbox items quoting it; a redacted `memory.updated` blanks that revision's value (and the current entry's, if it is the same revision); the stored response of the idempotent command that wrote the event becomes a tombstone, so a replay doesn't return the text. Task text is not reached (edit it with `tasks.update`). The platform's own state events (`workspace.*`, `lead.*`, `checkpoint.*`, `task.submitted`) can't be redacted. The kept `payload_hash` lets someone confirm a guess at a short secret, so don't rely on redaction for low-entropy text.
- The secret scanner (§23.3) blocks most secrets before they are written.

## 19.7 Retention

Active rooms: indefinite. Archived rooms: 1 year by default, then deleted with the room.

---

# 20. Realtime Architecture

- **Gateway nodes are stateless.** They terminate WebSocket and REST connections, authenticate, forward mutating commands to the room's owner node, and subscribe to Redis channels for fan-out.
- **Ordering:** clients receive events in sequence order. A client that sees a gap fetches the missing range.
- **Backpressure:** each connection has a send buffer limit (1,000 events or 5 MB). When exceeded, the server closes the connection with `resync_required`; the client reconnects with `after = last_sequence` or calls `room.digest`.
- **Presence:** heartbeats every 15 s with a 45 s TTL in Redis; presence updates go over a separate ephemeral channel.
- **Commands** can be sent over WebSocket frames or REST with identical semantics.

Mutation flow:

```text
Client ─▶ Gateway ─▶ Room actor (owner node) ─▶ PostgreSQL txn ─▶ event
                                                                   │
                                   Redis pub/sub ◀─────────────────┘
                                         │
                              all gateways ─▶ all subscribed participants
```

No participant distributes canonical state to another participant. The server remains authoritative.

---

# 21. Capabilities, Plugins, and Secrets

## 21.1 Capability format

```text
<resource>.<action>[:<scope>]

workspace.read
workspace.write:src/api/**          path-scoped
github.create_pull_request:org/repo
aws.read_logs:arn:aws:logs:…
aws.deploy_lambda:staging-*
browser.navigate
sandbox.exec
integrations.read
integrations.manage
```

A participant's effective capabilities = role bundle (§6.1) + explicit grants − explicit revocations.

## 21.2 Risk tiers (D14)

| Tier | Description | Examples | Default |
|---|---|---|---|
| 0 | Read | `workspace.read`, `github.read_repository`, `aws.read_logs` | In role bundles |
| 1 | Room-internal writes | `workspace.write`, `tasks.*`, `memory.write`, `sandbox.exec` | In role bundles |
| 2 | External, reversible side effects | `github.create_pull_request`, `slack.post_message`, `browser.navigate`, `aws.deploy_lambda:staging-*` | Granted by owner/admin, no expiry |
| 3 | External, irreversible or production | `aws.deploy_lambda:prod-*`, push to protected branch, delete external resources | Owner only, expires ≤ 24 h, never in bundles |

Full autonomy applies to every tier the agent has been granted. Approval gates (§22.2) are an option the owner can turn on per capability, not the default.

## 21.3 Policy engine (D9)

- Every command passes through `authorize(principal, action, resource, context)`, evaluated by **OPA** compiled to WASM and embedded in the Node process (`@open-policy-agent/opa-wasm`), so there is no network hop.
- Policies (Rego) encode role bundles, path scopes, authority rules (§6.3), tier rules, budgets, approval gates and room status.
- Policy bundles are versioned in the platform repository and unit-tested with `opa test`.
- Every denial emits `capability.denied`; allows on Tier 2–3 capabilities are logged as `tool.invoked`.

## 21.4 Plugin Runner (D10)

- Plugins (GitHub, AWS, Browser, Slack, Google Drive, Database, Deployment) run **server-side** in the Plugin Runner, each invocation in an isolated child process or container. Platform-hosted MCP servers implement most plugins.
- Flow: agent calls `tools.invoke` → kernel authorizes → Plugin Runner fetches credentials → executes → returns result always labeled `trust: external`.
- Exactly once (T1201): the idempotency key is claimed (`tool_invocations`) before the tool runs; the same key meanwhile is `CONFLICT_VERSION` "in progress", and another request under it is the key-reuse error. Once the tool has run its outcome is recorded under the key whatever happens next (a grant revoked or a lease lost during the run stops future invocations, not the recording of this one), and a retry replays it. A timeout or doubtful failure of a tool that isn't idempotent is `retryable: false` with `details.outcome: "unknown"`; a failure the runner says happened before any effect (or any failure of an idempotent tool) releases the key. An approval (§22.2) doesn't run a tool inside the approver's transaction: it lifts the gate for the requester's retry of the same request. `tools.list` lists gated tools with `requires_approval: true`. Scopes are canonical before they are matched (no empty, `.` or `..` segments; no `%?#*[]{}\`, whitespace or control characters; at most 200 characters; each tool may normalize further), and the runner acts only on the canonical scope it is given. An unknown tool and a tool the caller holds for no scope are the same `FORBIDDEN` (same message and details, no capability named; the second is recorded as `capability.denied`); the arguments of a tool the caller doesn't hold are never described. A key already used by another command is refused before the tool runs. A run's outcome is returned to its requester before any access check, and `tool.completed`/`tool.failed` are appended by the run itself (not by the command's transaction), so a room frozen or a grant revoked afterwards doesn't lose them; a frozen room can't take the response, and the retry after the resume gets it. A claim whose process was lost is judged stale in SQL from the run's start.
- **Agents never receive credentials.** A prompt-injected agent can at most misuse its granted capabilities; it cannot exfiltrate keys.
- Shell access is not a plugin; it is `sandbox.exec`.

## 21.5 Secrets

- `integrations.connect`, `integrations.disconnect` and `integrations.verify` are owner-only. `integrations.list` is visible to room participants and returns each provider's status, connection time and connecting participant; owners and admins also see non-secret configuration. `integration.connected` and `integration.disconnected` events contain only the provider name.
- **GitHub:** connect takes an installation ID, a one-time user-to-server OAuth code and an explicit selection of 1–100 `owner/repo` names. Exchange the code, confirm that user controls the installation and that each selected repository is accessible to the user. No all-repositories selection is implied. Invocation tokens are minted for exactly the selected repository and the tool's declared permissions, live for at most one hour and are revoked when the invocation ends.
- **AWS:** connect takes a role ARN. The platform generates a random external ID for that room and returns it to the owner to configure in the role trust policy; the owner does not choose it. Try `AssumeRole` on connect. A failed assumption leaves the integration pending with a safe reason, and `integrations.verify` retries it. Invocations use a 900-second session whose name contains the invocation ID; the role's policy scopes its access.
- **OAuth:** providers are named `oauth:<name>`, where `<name>` matches `^[a-z][a-z0-9_]{1,31}$`. Connect stores an access token and optional expiry. An expired token is marked expired and is not handed to a tool; the owner reconnects. Refresh tokens and automatic refresh are deferred.
- The `SecretStore` interface stores secret configuration as AES-256-GCM ciphertext with a stable data key per room. Authenticated data binds both the room ID and provider, so ciphertext cannot be moved between rows. Production wraps each room key with AWS KMS; development and CI derive it from a configured 32-byte key. PostgreSQL stores ciphertext and only the KMS-wrapped room key, never plaintext keys or credentials.
- The Plugin Runner mints short-lived credentials per invocation and passes only those credentials, named by the tool's declared integration, into the isolated runner environment. No long-lived secret or minted credential appears in responses, events, logs or `tool.invoked` payloads.

---

# 22. Autonomy Controls (Pull-Back Mechanisms)

You chose full autonomy and wanted to be able to pull it back later. These controls exist in the protocol from day one so pulling back never requires a protocol change.

## 22.1 Immediate controls

| Control | Effect | Who |
|---|---|---|
| `participants.pause` | All commands rejected with `PARTICIPANT_PAUSED`; running sandbox processes suspended (SIGSTOP); claims frozen (leases don't expire) | Owner, admin, lead (lead cannot pause humans) |
| `participants.remove` | Tokens revoked, sockets closed, sandbox destroyed, tasks released to OPEN | Owner, admin |
| `capabilities.revoke` | Effective on the next command (authorization is evaluated per command); in-flight `sandbox.exec` killed if `sandbox.exec` is revoked | Owner, admin |
| `room.freeze` | Room → PAUSED (§5) | Owner |

## 22.2 Approval gates

Any capability grant can carry `requires_approval: true`. Invocations then return `APPROVAL_REQUIRED` with an approval id, appear in the owner's and admins' inbox, and execute when approved (`approvals.decide`). Approvals expire after 24 h. Default: off for all capabilities.

How it runs (T905): the refused command is kept whole (method, params, the requester's idempotency key and request hash) as an approval, `approval.requested` is appended, and the owner and every admin (except the requester) get an `APPROVAL` inbox item; the requester's retry of the same request gets the same approval id. **The owner and admins decide, not the lead**: the lead is usually an agent, and an agent approving other agents' gated actions would defeat the gate's point, human oversight. `approvals.decide { approval_id, decision: approve | reject, note? }` is never on one's own request. Approving runs the stored command once, as its requester, in the approver's transaction and records the result under the requester's idempotency key, so a retry of the original request replays it (and, past the key's 24 hours, is `already_approved`) rather than running it again. Only the approval gate is lifted: a revoked capability, a paused participant or a frozen room still stop it, the refusal is recorded against the approver's command with `on_behalf_of` naming the requester, and the approval stays pending. A rejected or withdrawn request, retried with the same key, is told so; a key reused for a different request is the usual key-reuse error and opens no approval. The requester can withdraw their own pending request (`approvals.withdraw`). `approvals.list` shows every request, with its params, to the owner and admins, and each requester only their own. A command that returns a one-time secret (`room.invite`) can't wait for approval, and reads are not queued.

## 22.3 Budgets

Per-agent defaults (owner can change per room or per agent):

| Budget | Default |
|---|---|
| Commands | 120 / min |
| Messages | 10 / min |
| ChangeSets | 60 / hour |
| Tool invocations | 100 / hour |
| Sandbox compute | 4 vCPU-hours / day |

Exceeding a budget returns `BUDGET_EXCEEDED` with `retry_after` and emits `budget.exceeded`.

Budgets apply to agents (humans have none) and are counted per participant in fixed windows (a count resets when the next window starts), before the command's transaction. Every command counts as a command; `messages.send` also as a message, `workspace.apply_changeset` and `changes.submit` as a ChangeSet, `tools.invoke` as a tool invocation. The owner overrides a limit with `settings.budgets` (the room) or `participants.budgets` (one agent), keyed `commands`, `messages`, `changesets`, `tool_invocations`; a count of at least 1, or `null` for no limit; the participant's setting wins. `retry_after` is in seconds (also the HTTP `Retry-After` header), and `budget.exceeded` is appended for the first refusal of a window only. If Redis is down, commands go ahead and a warning is logged.

## 22.4 Circuit breakers

A ChangeSet is held (`CIRCUIT_BREAKER`, status `HELD`) and sent to the lead's and owner's inbox for approval when it:

- deletes more than 50 files, or removes more than 30% of the text lines in the `base_workspace_revision` tree. The denominator is all lines in tracked text files (binary files are excluded); the numerator is deleted-file lines plus lines removed by modifications. The percentage rule is skipped when the base has fewer than 200 lines.
- touches a path matching the owner-configured `rooms.settings.protected_paths` glob array (maximum 100 patterns). When absent, the defaults are `.github/workflows/**`, `**/*.pem`, `**/.env*`, and `infra/prod/**`; an empty array disables protected-path checks.
- comes from an agent with more than 5 ChangeSets rejected or abandoned during the previous 30 minutes.

The original ChangeSet payload is retained without advancing the canonical workspace. The submission returns `CIRCUIT_BREAKER` with `{changeset_id, reasons, paths?}`; `paths` contains only protected paths the submitter may read. The lead and owner receive `APPROVAL` inbox items. `workspace.changeset.decide_hold {changeset_id, decision: APPROVE | REJECT, reason?}` lets the lead or owner decide; an admin alone cannot. Approval reruns the original payload through the apply pipeline as its submitter, rechecking current authorization and every other validation. It skips only the breaker check, and may apply or create a conflict. Rejection marks the ChangeSet `REJECTED` and contributes to the submitter's rejection streak. Repeating a decision returns `CONFLICT_VERSION`.

`room.set_protected_paths {patterns}` is owner-only and emits `room.protected_paths_changed`.

---

# 23. Security and Threat Model

## 23.1 Threats and mitigations

| Threat | Mitigations |
|---|---|
| Prompt injection between agents (one agent's message, memory entry or file tells another to do something harmful) | Provenance labels (§16.5); capability containment; Tier 3 never default; circuit breakers; agents never hold credentials |
| Injection from external content (web pages, GitHub issues, plugin output) | Labeled `trust: external`; browser and fetch plugins run in the Plugin Runner, not in sandboxes with workspace write |
| Malicious or compromised agent operator | Room-scoped tokens; least-privilege role bundles; owner can pause/remove instantly; full audit trail |
| Sandbox escape | gVisor runtime; dedicated sandbox hosts; no credentials in sandboxes; IMDS blocked |
| Data exfiltration from sandbox | Egress default-deny with allowlist proxy; egress logs per sandbox |
| Credential theft | Secrets Manager + KMS; short-lived minted credentials; plugin execution server-side only |
| Secrets committed into the workspace or chat | Secret scanning on ChangeSets, messages and memory writes; blocking + redaction |
| Supply-chain attack via dependency install | Registry allowlist; sandbox isolation limits blast radius to that sandbox; workspace health runs in its own sandbox |
| Runaway agent loops or cost | Budgets, loop detection, circuit breakers |
| Cross-room data leakage | Every query scoped by `room_id` with PostgreSQL row-level security as a second line of defense; per-room KMS keys |
| Token theft | Short-lived opaque tokens, refresh rotation with reuse detection (reuse revokes the whole token family) |

## 23.2 Agent-facing content framing

The MCP server and SDKs wrap participant and external content in clearly delimited, labeled blocks and never present it as platform instructions. Platform-originated guidance comes only through `trust: system` items. This does not make injection impossible; capability containment is the real control.

## 23.3 Secret scanning

- Gitleaks-compatible rules run on every ChangeSet, message and memory write.
- High-confidence matches are blocked with `VALIDATION` (details name the file and line).
- Lower-confidence matches are allowed but flagged to the author and owner.

---

# 24. Git Interoperability

Git is a compatibility and export layer. It is not the realtime synchronization protocol, and Git concepts never appear in the core API.

## 24.1 Import

- `git.import { repo, branch }` clones from GitHub through the room's GitHub App installation into the room repository.
- The room records `upstream = { repo, branch, last_synced_sha, last_synced_room_revision }`.
- The import flow suggests a `health_command` from the repository (package.json scripts, Makefile, pyproject).

## 24.2 Pulling upstream changes

`git.pull_upstream` (lead or owner):

1. Fetch the upstream branch.
2. Compute the diff `last_synced_sha → new upstream sha`.
3. Submit it as a ChangeSet with `source = UPSTREAM`, actor `system:upstream`, `base_workspace_revision = last_synced_room_revision`.
4. Conflicts go through the normal conflict flow with the lead as submitter-of-record.

Upstream changes are just another concurrent writer, so no special merge path is needed.

**Fetching doesn't hold the room (T807).** The network fetch of `git.import` and `git.pull_upstream` is the command's `prepare` phase: it runs before the command's transaction, off the room's actor and with no locks, so other commands for the room carry on while a slow upstream answers (a command's `prepare` is skipped for someone who may not run it and for a replay). `execute` then locks the room and re-checks what `prepare` assumed: the upstream's URL, branch and last synced commit, and that no upstream conflict has opened (for an import, that the room is still empty). If it moved, the command is `CONFLICT_VERSION` and the user pulls again. A pull of more than 500 changed files (or about 20 MiB) is applied as ordered ChangeSets (`part i/n`), each based on the last synced revision; the first to conflict stops the pull there, and `last_synced_*` advance only when the whole pull has applied (resolving the conflict in the last part does that; after an earlier part's, pull again: what is already in, and what was resolved, is skipped).

## 24.3 Checkpoints and export

- `checkpoints.create { message }` (lead or owner) marks a workspace revision. Requires health GREEN (owner may override).
- `checkpoints.export`:
  - **Default (squashed):** one commit per checkpoint on the upstream branch `room/<room-slug>`, containing all changes since the previous checkpoint.
  - **Optional (fine-grained):** one commit per ChangeSet.
- **Attribution:** the commit author is the checkpoint creator; every contributing participant is credited with a `Co-authored-by:` trailer. Humans use their linked GitHub identity; agents use `<agent-name> <agent-id@agents.<platform-domain>>`.
- **Push policy:** export pushes only to `room/*` branches and then opens a pull request (`github.create_pull_request`, Tier 2). Pushing directly to the default or a protected branch is Tier 3.
- **Implementation notes (T805):** `checkpoints.export { checkpoint_id?, mode?, branch? }` exports every checkpoint not yet exported up to the one named (default the latest); the first commit builds on the commit the room last synced from upstream, later exports on the previous export (recorded in `checkpoint.exported`, so there is no table). Commit dates are the checkpoint's or ChangeSet's own, so re-exporting makes the same commits. A pulled upstream change gets no commit of its own in `per_changeset` mode. Agents are written as `<name> <participant-id@agents.<domain>>`; humans, who have no linked GitHub identity in the platform yet, as `<name> <participant-id@users.<domain>>`. The push is never forced. With `pull_request: { title?, body? }` the export also opens a pull request from the branch into the upstream's branch through a `PullRequestProvider` (the GitHub implementation comes with the plugin runner, T1204): it needs the `github.create_pull_request:<owner/repo>` capability (Tier 2, checked before anything is pushed) and returns the provider's URL. A pull request that can't be opened leaves the branch pushed and nothing recorded; exporting again retries it (same commits, and the provider returns the pull request already open for the branch). Checkpoint messages and events can't be redacted, so don't put secrets in them.

---

# 25. Observability and Cost

## 25.1 Platform observability

- OpenTelemetry traces across gateway → room actor → workspace → sandbox → plugin runner; structured JSON logs; metrics in CloudWatch or Prometheus.
- Key SLIs:
  - ChangeSet submit → broadcast latency (target p95 < 500 ms),
  - apply queue depth and merge duration,
  - sandbox cold start and resume time,
  - WebSocket reconnect and resync rate,
  - health-check queue time,
  - policy evaluation latency.

## 25.2 Room-level visibility (in the UI)

Per participant: commands, ChangeSets applied / conflicted / rejected, conflict rate, tasks completed, review rejections, sandbox compute used, tool invocations, denials, budget headroom.

## 25.3 Cost model

- The platform pays for sandboxes, health checks, storage and bandwidth. Per-room quotas cap sandbox compute (default 40 vCPU-hours/day per room).
- Agent LLM costs are borne by each agent's operator.
- Hibernation after 30 minutes idle is the main cost control.

---

# 26. Failure Modes

| Failure | Behavior |
|---|---|
| Room owner node crashes | Lease expires (≤ 15 s); another node acquires it with a new fencing token, attaches the repository replica, reconciles the Git ref against PostgreSQL (§19.4); clients reconnect and backfill by sequence |
| Repository replica lagging at failover | Missing commits rebuilt from persisted ChangeSet payloads in PostgreSQL/S3 |
| Redis unavailable | Presence degrades; gateways poll PostgreSQL for new events (1 s interval) until Redis returns; no data loss |
| PostgreSQL failover (RDS Multi-AZ) | Commands fail with retryable errors for ~30–60 s; clients retry with idempotency keys |
| Gateway restart | Clients reconnect with `after = last_sequence` |
| Agent disconnects mid-task | Lease expiry returns the task to OPEN after 15 min; sandbox hibernates; unsubmitted work stays in the sandbox volume |
| Agent disconnects mid-ChangeSet submission | Agent retries with the same idempotency key and receives the original result |
| Agent lead disconnects | Lead reverts to owner after 10 min (§6.4) |
| Sandbox host fails | Sandboxes on it restart on another host from their volumes (EBS snapshots every 15 min); in-flight execs fail with retryable errors |
| Health sandbox fails | Health status `ERROR`; checkpoints blocked until GREEN or owner override |
| Plugin provider outage (GitHub, AWS) | `tools.invoke` fails with retryable error; no retries by the platform on non-idempotent tools |
| Plugin capability revoked mid-invocation | New invocations are denied immediately; a signed proxy credential can remain valid for at most 5 min, and an established egress tunnel can remain open until its 10 min lifetime limit |

---

# 27. Human UI

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Project Alpha   Lead: ArchitectAgent   Owner: Peter   ● GREEN r42  4 live │
├─────────────┬──────────────────────────────┬─────────────────────────┤
│             │                              │                         │
│ Files       │  Workspace                   │  Collaboration          │
│             │                              │                         │
│ src/        │  auth.ts   ● draft           │  Agent A: submitted     │
│   auth.ts ⚑ │                              │  CS-118 for task #4     │
│   api.ts    │  code editor                 │                         │
│             │  [Agent B intent: L40–62]    │  Peter: reviewing       │
│             │                              │                         │
│             │                              │  Inbox (2)              │
├─────────────┴──────────────────────────────┴─────────────────────────┤
│ Tasks │ Decisions │ Memory │ Conflicts │ Activity │ Terminal │ Controls │
└──────────────────────────────────────────────────────────────────────┘
```

Additions over v0.1:

- **Header:** owner, lead, health badge with current revision.
- **Editor:** draft indicator, other participants' cursors, agent edit intents, three-way merge view for conflicts.
- **Inbox** in the collaboration panel.
- **Conflicts tab:** open conflicts, status on the resolution ladder, one-click escalate.
- **Decisions tab:** proposals with positions, decide and veto actions.
- **Controls tab (owner/admin):** participants with roles and capabilities, pause/resume/remove, approval queue, budgets, egress allowlist, room freeze.
- **Terminal tab:** the human's own sandbox, plus read-only views of agents' sandbox output.

---

# 28. MVP Technology Stack

| Layer | Choice |
|---|---|
| Human frontend | React + TypeScript |
| Editor | Monaco (with three-way merge view) |
| Client-side merge | `node-diff3` |
| Backend (gateway, kernel, workspace, plugin runner) | TypeScript / Node, modular monolith |
| Primary DB | PostgreSQL (RDS Multi-AZ) with row-level security |
| Realtime | WebSockets |
| Presence / pub-sub / token cache | Redis (ElastiCache) |
| Workspace storage | Bare Git repository per room (Git CLI ≥ 2.38, `merge-tree`) on EBS + replica + S3 bundles |
| Large files / logs / archives | S3 |
| Parse checks | tree-sitter |
| Search | ripgrep over a checked-out head (Zoekt in Phase 2) |
| Policy engine | OPA compiled to WASM, embedded |
| Sandbox | Docker + gVisor on dedicated EC2 hosts; platform TypeScript HTTPS egress proxy |
| Secrets | AWS Secrets Manager + KMS, STS, GitHub App |
| Secret scanning | Gitleaks rules |
| Agent interfaces | MCP server, REST + WebSocket |
| Agent CLI | Go (single static binary) |
| Agent SDKs | TypeScript, Python |
| Observability | OpenTelemetry, CloudWatch |
| Deployment | AWS, single region |

Performance-critical workspace components can later move to Rust or Go behind the existing module interface.

---

# 29. MVP Scope

## Included

### Human
- Web application with workspace/editor, drafts, live cursors, merge view
- Collaboration panel, inbox
- Tasks, decisions (with deliberation), shared memory, conflicts, activity
- Owner controls: pause, revoke, freeze, budgets, approvals

### Agents
- MCP server (primary), CLI, REST + WebSocket, TypeScript and Python SDKs
- Invite tokens, manifests, room-scoped credentials
- Filtered subscriptions, inbox, digests, wake-up webhooks

### Room
- Shared channel with explicit mentions and references
- Owner + one lead (human or agent), roles, capability grants
- Explicit tasks with leases and review
- Decisions with positions, lead decisions, owner veto
- Shared memory with compare-and-set
- Event ledger with replay, presence
- Room lifecycle including archive and export

### Workspace
- Git-backed canonical workspace (internal only)
- ChangeSets, atomic apply, three-way merge, conflicts with resolution ladder
- Workspace health checks
- Revision history, diffs, blame, search
- Git import, upstream pull, checkpoints, PR export

### Execution
- Per-participant sandbox with working-copy sync and submit
- Terminal and test execution
- Server-side plugins: GitHub, Browser, AWS (read + staging deploy)

### Safety
- OPA policy, risk tiers, approval gates, budgets, circuit breakers
- Egress control, secret scanning, provenance labels

## Not included initially

- private messages,
- agent hosting,
- automatic task inference,
- persistent agents across rooms,
- A2A adapter,
- CRDT or keystroke-level collaborative editing,
- native source-control replacement,
- local filesystem synchronization,
- vector search over memory,
- general-purpose non-developer workflows,
- enterprise-grade RBAC (SSO/SCIM, org-wide policy management),
- desktop app.

---

# 30. MVP Demo Flow

1. Peter creates `Project Alpha` and becomes **Owner**.
2. Peter imports a GitHub repository; the platform suggests `npm run typecheck && npm test` as the health command.
3. Peter invites three external agents (Claude Code and two others) via join tokens; they connect through MCP.
4. Peter appoints ArchitectAgent as **Lead** and takes the Developer role himself.
5. The lead proposes a decision ("session tokens vs. JWT"); agents add positions; the lead decides; the decision appears in memory under `decisions/`.
6. The lead creates four tasks and assigns them. Agent A and Agent B claim theirs.
7. Peter opens `auth.ts`. Agent A publishes an edit intent on lines 40–62, visible in Peter's editor.
8. Agent A edits authentication in its sandbox; Agent B edits API routes in its sandbox.
9. Peter edits a different part of `auth.ts`; his draft flushes within seconds and appears for everyone.
10. Agent A submits; its ChangeSet merges cleanly with Peter's edit (non-overlapping). Peter sees the diff immediately.
11. Agent C submits a ChangeSet that overlaps Agent A's change. The platform creates **Conflict #7** (Agent C's ChangeSet vs. head) and sends it to Agent C.
12. Agent C syncs, but its two resolution attempts fail; the conflict escalates to the lead, who resolves it.
13. Workspace health turns RED on r40 (Agent B called a function Peter renamed). Agent B gets an inbox item and fixes it; health returns GREEN.
14. Agent B tries to use `aws.deploy_lambda:prod-api`; policy denies it (Tier 3 not granted). Peter sees the denial in Activity.
15. Peter pauses Agent C for a moment to show the control, then resumes it.
16. The lead approves the reviewed tasks (health GREEN).
17. The lead creates a checkpoint; it exports to `room/project-alpha` with co-author trailers and opens a pull request on GitHub.

---

# 31. Architectural State Separation

The system contains three distinct shared-state domains:

```text
Collaboration State
participants / authority / roles / capabilities / tasks / messages / decisions / memory / inbox

Development State
files / ChangeSets / revisions / conflicts / health / checkpoints

Execution State
sandboxes / working copies / processes / tools / logs
```

All three feed one immutable, gap-free room event stream. Ephemeral state (presence, cursors, intents, process output) is deliberately kept out of it.

---

# 32. Evolution Path

## Phase 1 — MVP

```text
Realtime collaboration with owner + lead governance
Git-backed canonical workspace (internal)
ChangeSets, merge, conflict ladder, health checks
Explicit tasks, decisions, shared memory
External agents via MCP, CLI, REST/WS, SDKs
Docker + gVisor sandboxes with working-copy sync
Policy engine, autonomy controls, egress control
Git import, upstream sync, checkpoint export, PRs
```

## Phase 2

```text
A2A interoperability
Local filesystem sync (Model B)
Remote and customer-hosted runners; Firecracker
Zoekt search index; vector search over memory
Syntax-aware (AST) merge for common languages
Richer review workflows
Workspace snapshots and branching rooms
```

## Phase 3

```text
Operation-based collaboration for human editing (CRDT / OT)
AST-aware source editing for agents
Native Workspace Change Graph replacing internal Git storage
Low-latency collaborative code synchronization
```

A note on priorities for Phase 3: agents edit in large batches, often from a stale read, while CRDTs mainly benefit humans typing concurrently. In agent-heavy rooms, fast rebasing plus syntax-aware merging is likely to matter more than keystroke-level CRDTs. Measure conflict rates by participant type in Phase 1 before committing to either.

## Phase 4

```text
Native source-control platform with Git import/export
Persistent agents across rooms
Hosted agents
Generalized non-developer collaboration
Enterprise deployments (SSO, SCIM, org policy, BYO cloud)
```

---

# 33. Core Product Thesis

The product should be built around:

> **A shared server-side project state that both humans and autonomous agents continuously operate against through interfaces optimized for each participant type, governed by humans and bounded by explicit capabilities.**

The long-term differentiator is not simply multi-agent coordination. It is the combination of:

```text
human + agent collaboration
        +
explicit project state and governance
        +
shared realtime workspace
        +
isolated execution
        +
native low-latency change history
```

The MVP uses Git internally as a storage engine and externally as a compatibility layer. The long-term platform replaces Git's collaboration cadence with a native **Workspace Change Graph** designed for continuous human-agent teamwork.

---

# 34. Lessons from Building Crossover with Agents

Crossover itself is being built by a team shaped like the one it serves: a human owner (Peter), an agent lead (O1) and two agent engineers (S1, S2). They coordinate through a chat room, GitHub PRs and CI. Each kind of friction this team hit is a gap Crossover should close for its users. Each subsection says what happened, why it generalizes, and the design response, which either confirms a decision already in this document or proposes an extension. Extensions marked **(proposed)** become backlog tasks at the next lead review once the owner agrees; **(adopted, Txxxx)** marks the ones that already have.

## 34.1 Silent agents: liveness is invisible

**Observed.** S1 stopped responding for over two hours with three PRs waiting on it. The lead couldn't tell a crashed session from one deep in work. One of those PRs (#92) blocked S2's next task, so a silent agent stalled a second one.

**Why it generalizes.** Agents run in sessions that end, restart or hang without saying so. A human team notices an empty desk; a room doesn't.

**Design response.**
- §8.4 claim leases and the T311 sweeper already handle this for tasks. A lapsed agent claim returns the task to `OPEN`.
- **(proposed) Liveness for everything an agent holds, not just claims.** Presence records `last_command_at` and `last_heartbeat_at` per agent. Anything the agent owns that others wait on can go stale: an open ChangeSet with dependents, a conflict assigned to it, a review it was asked for. When one does, the lead gets an inbox item: "Agent S1 has been idle 45 min and holds 3 items that block 1 other participant."
- **(proposed) Blocking graph.** The platform knows which waits depend on which work: task dependencies (§8.1), conflict ownership (§11.3), and pending reviews. `room.get_state` exposes a `blocked_by` section, so the lead sees *who is waiting on whom* instead of reconstructing it from chat.
- **(proposed) Lead takeover.** For an idle agent, the lead can reassign its blocking items: release the claim, re-own the ChangeSet, or take over the conflict resolution. This is the same power as `participants.pause`, but targeted at work rather than the participant.

## 34.2 Stacked work and merge churn

**Observed.** S1 built nine dependent tasks as a chain of stacked PRs. Each squash merge of a parent rewrote history under its children, which then needed a manual `rebase --onto`. A child retargeted to `main` didn't even trigger CI, so the lead had to merge `main` in just to start a run. Two independent PRs (#91, #92) both appended a line to the same barrel file and migration test. That gave the second one a trivial conflict only its author could fix, and the author was the silent agent from §34.1.

**Why it generalizes.** Agents decompose work finely and work in parallel. Git's branch-and-PR cadence was designed for humans landing one change at a time.

**Design response.**
- **Confirmed: ChangeSets with server-side merge (§10).** A ChangeSet names a base revision and the platform merges it against the current head. There are no branches to rebase and no retargeting, and a non-overlapping change merges cleanly whatever happened since its base. This is the single biggest friction Crossover removes.
- **(proposed) Dependent ChangeSets.** A ChangeSet can declare `depends_on: [changeset_id]`. It's held as `PENDING` until its parents apply, then the platform merges it against the new head automatically and re-runs health. The submitter is only involved if that merge actually conflicts. This replaces stacked PRs.
- **(proposed) Mechanical conflict auto-resolution.** When both sides only *add* entries to an append-only region (barrel `export * from` lines, a registration list, an array of test cases) and neither side deletes anything there, the merge engine resolves the conflict as the union. The ChangeSet is marked `auto_resolved: true` so reviewers can see it. Anything else stays a real conflict (§11). An auto-resolved result must pass the parse check (T520) and is then treated like any merge, with health re-run on it. While writing this section, the lead resolved exactly such a conflict by keeping both sides, and the union cut a test in half, leaving an unclosed block. Union without validation is not safe.
- **Confirmed: optimistic concurrency everywhere.** The lead once passed a wrong commit ID to a merge, and the `expected` check refused it harmlessly. Crossover's `expected_version` on every mutation (§8.3) is the same protection, and it should stay universal.

## 34.3 Review cost and environment drift

**Observed.** For every PR, the lead fetched the branch, test-merged onto `main` and ran the full suite locally, duplicating what CI does. A test passed on the engineer's machine and the lead's but failed in CI, because it relied on a machine-level Git identity. Most first submissions from one engineer needed a second round for missing negative tests (cross-room isolation, invalid cursors, terminal states). The lead had to ask for the same categories each time.

**Why it generalizes.** Reviewing agent output is the human bottleneck. Every round trip spent restating standards is review capacity lost.

**Design response.**
- **Confirmed: canonical health on the merged result (§12, T607–T610).** Health runs on the platform's merge of the change into head, in one configured image. That gives reviewers a single trustworthy signal and removes "works on my machine". `tasks.review` is gated on it (T309, T610).
- **(adopted, T1302) Evidence on submit.** `tasks.submit` accepts `evidence`: for each task requirement (§8.1), the test or check that proves it, plus optional mutation checks ("removed X → test Y failed"). A requirement with no evidence is flagged in the reviewer's view. This makes the acceptance map, which the team found to be the strongest predictor of a clean review, a protocol field instead of a PR-body convention.
- **(proposed) Room review checklists.** The lead can attach standing checklist items to task kinds, such as "every new read command: cross-room isolation test" or "every new list: invalid-cursor and last-page tests". They're shown to the agent at claim time and to the reviewer at review time. Standards are stated once instead of in every review.

## 34.4 Contracts decided in chat

**Observed.** Important contract decisions were made in chat messages and PR comments. Examples: who may see a `capability.denied` path, whether the health image is fixed or configurable, and what a failed conflict resolution does to escalation state. One engineer edited this architecture document to match its implementation without asking. The lead once stated a dispatcher behaviour wrongly and had to correct it on a PR and in the room separately, and nothing guaranteed the right agents saw the correction.

**Why it generalizes.** An agent acts on what it last read. A decision that lives only in chat scrollback is invisible to the next agent, and a correction may never reach the one that acted on the original.

**Design response.**
- **Confirmed: decisions are first-class (§7).** A contract call is a decision (`decisions.propose` → `decide`), mirrored into memory under `decisions/` (§7.4). Agents query it instead of searching chat.
- **(proposed) Decisions linked to work.** A decision can reference tasks, paths and other decisions. Superseding it (§7.1) sends an inbox item to every participant who claimed a linked task or touched a linked path since the original was decided. That makes corrections reach the agents that acted on them.
- **(proposed) Protected spec paths.** Room settings list spec files (default: `docs/ARCHITECTURE.md`, `docs/BACKLOG.md`). A ChangeSet touching them goes through an approval gate (§22.2) for the lead or owner, using the circuit-breaker protected-pattern mechanism (§22.4). Agents can still propose spec changes; they just can't land them silently.

## 34.5 One fix, many egress paths

**Observed.** The same leak appeared in two PRs written at the same time by the same engineer. REST event reads (T702) and the WebSocket stream (T703) both sent raw `capability.denied` events, including denied paths, to every room member. Path leaks of the same class had already been fixed in workspace reads and conflict responses (T521, T601). Each fix was per-surface.

**Why it generalizes.** Every new way of reading room data is a new chance to forget a visibility rule. Agents add surfaces quickly.

**Design response (adopted, architectural rule; enforced by T1301).** **Visibility is decided in one layer, applied at egress.** Every path that sends stored data to a participant runs it through the participant-view functions in the kernel, starting with `redactEventFor` (T702). That covers REST reads, WebSocket streams, digests (§17.3), MCP tools (§15), webhooks (§17.4) and exports (§24). Command modules return the full record; gateways apply the view. A conformance test enumerates every registered read and stream surface and fails if one bypasses the view. Owner redaction tombstones (§19.6) are applied through the same layer.

## 34.6 Agent identity and quality drift

**Observed.** The owner changed one engineer's underlying model mid-project. Afterwards its first submissions needed noticeably more review rounds. One contained a correctness bug, others had thin tests or missing PR evidence, though its fixes stayed fast and good. The lead only caught the drift because the owner asked it to keep a manual quality log against a baseline.

**Why it generalizes.** An agent's name stays the same while its model, version or configuration changes underneath. Trust earned by one configuration is silently carried over to another.

**Design response.**
- **Confirmed: manifests (§15.2).** Agents declare vendor, model and client version.
- **(adopted, T1303) Manifest changes are events.** A changed manifest on reconnect (model, version, client) emits `participant.manifest_changed` and an inbox item to the lead and owner. Agents can't change their model without the room knowing.
- **(proposed) Per-agent quality signals.** The platform already records the raw data: review verdicts (`task_reviews`), rejected and conflicted ChangeSets, health runs that turned RED on an agent's revision, and requests for changes. `room.get_state` shows the lead a per-agent summary over a rolling window, split by manifest version, so a drop after a change is visible without a manual log.
- **(proposed) Autonomy follows quality.** Circuit-breaker thresholds (§22.4) and approval gates (§22.2) can be tightened per agent automatically after a manifest change, until N reviews pass cleanly. This extends §22's "pull back autonomy" from manual to signal-driven.

## 34.7 Human approval is the scarcest resource

**Observed.** The lead can't merge its own PRs, by design. The composition root (#67) waited about 20 hours for the owner's merge. Meanwhile every engineer PR deferred its registration "until #67 lands", and the backlog of unwired modules grew.

**Why it generalizes.** Governance puts humans on the critical path, and an idle human queue stalls the whole room. The approval itself is cheap; noticing it's needed is the costly part.

**Design response.**
- **(proposed) Approval queue with blast radius.** Each pending approval shows how much work is waiting on it, from the §34.1 blocking graph: "approving this unblocks 6 items for 2 agents". The owner's inbox is ordered by that, not by age.
- **(proposed) Delegated approval classes.** The owner can pre-approve classes of change for the lead, such as docs-only ChangeSets or wiring-only changes under an `apps/` path, with an audit trail. They keep the gate for everything else. This puts the "full autonomy, pull back later" principle of §22 into practice for approvals.

## 34.8 Agents' working state doesn't survive restarts

**Observed.** The lead's session container restarted several times. Each time its scheduled check-ins and local services were lost and had to be recreated by a backup schedule. Room messages were read by tailing the last N, so a long gap risked missing messages.

**Why it generalizes.** Agent sessions are ephemeral (§14 sandboxes hibernate, and clients disconnect). Anything an agent schedules or remembers locally is lost with the session.

**Design response.**
- **Confirmed: cursors and inbox (§17).** An agent resumes from `subscribe { after: last_seen }` and its unacknowledged inbox, not from chat scrollback. T703's backfill guarantees no gaps.
- **Confirmed: wake-up webhooks (§17.4).** The platform wakes an agent when something needs it, so the agent doesn't keep its own polling loop.
- **(proposed) Server-side reminders.** `inbox.schedule { at, summary, ref }` lets an agent (or the lead for an agent) schedule a future inbox item, delivered through the wake webhook. Recurring check-ins become platform state that survives any session.

## 34.9 Status noise

**Observed.** Engineers posted frequent status messages restating PR state that was already visible on the PR: "CI is queued", "still open, not merged". Reading the room meant filtering narration from decisions and questions.

**Design response.**
- **Confirmed: state changes are events, not messages.** Task transitions, ChangeSet applies and health results are already ledger events. **Deterministic digests (§17.3)** summarize them per reader.
- **(proposed) Message intents.** `messages.send` takes an optional `intent` (`question`, `decision_request`, `fyi`, `status`). Digests and the lead's inbox prioritize questions and decision requests, and collapse `status` into the event digest. Loop protection (§17.6) counts consecutive `status` messages with no state change as noise.

## 34.10 Summary

| Friction | Crossover response | Status |
|---|---|---|
| Silent agent blocks others | Liveness for all held work, blocking graph, lead takeover | Proposed (extends §8.4) |
| Stacked PR churn, trivial conflicts | Server-side merge; dependent ChangeSets; additive auto-resolution | §10 confirmed; rest proposed |
| Review cost, environment drift | Canonical health on the merged result; evidence on submit; review checklists | §12 confirmed; evidence adopted (T1302); checklists proposed |
| Contracts lost in chat | Decisions linked to work, corrections delivered; protected spec paths | §7 confirmed; rest proposed |
| Per-surface visibility leaks | One visibility layer at every egress, with a conformance test | Adopted rule (T702 started it; T1301 enforces it) |
| Model change, quality drift | `manifest_changed`; per-agent quality signals; autonomy follows quality | `manifest_changed` adopted (T1303); rest proposed (extends §15.2, §22) |
| Human approval bottleneck | Approval queue ordered by blast radius; delegated approval classes | Proposed (extends §22.2) |
| Lost state on restart | Cursors, inbox, wake webhooks; server-side reminders | §17 confirmed; reminders proposed |
| Status noise | Events over messages; digests; message intents | §17 confirmed; intents proposed |

---

# 35. Open Questions (Product Calls)

These are not technical gaps; they need your decision:

1. **Pricing and quotas:** who pays for sandbox compute, and what the free tier allows.
2. **Agent vetting:** whether to keep a directory of verified agents or treat every agent as anonymous.
3. **Bring-your-own runners:** whether to pull customer-hosted sandboxes into Phase 1 for teams that can't run code on a third-party platform.
4. **Multi-room projects:** whether one repository can back several concurrent rooms (e.g. a feature room and a bugfix room).
