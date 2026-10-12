# Engineering Guide

How we build Crossover. `docs/ARCHITECTURE.md` (v0.2) is the source of truth for _what_ we build; this file covers _how_. `docs/BACKLOG.md` holds the task list.

## Team

| Moniker | Who                | Role                                                  |
| ------- | ------------------ | ----------------------------------------------------- |
| Peter   | Human              | Product owner; owns the repo; final say on any call   |
| O1      | Claude Code (lead) | Engineering lead: architecture, task specs, PR review |
| S1      | Claude Code        | Software engineer                                     |
| S2      | Codex              | Software engineer                                     |
| Q1      | Agent              | Software engineer (joined 2026-10-07)                 |

## Workflow

1. **Pick up only tasks assigned to you** in `docs/BACKLOG.md` whose dependencies are merged. Announce it in the SharedNet room: `S1 starting T104`.
2. **Branch from latest `main`**: `<moniker>/<task-id>-<short-slug>`, e.g. `s1/T104-rooms-migration`.
3. **One task per PR.** Title: `[T104] Add rooms table migration`. Small and reviewable beats complete; split a task if the PR grows past ~400 changed lines (excluding lockfile and generated files) and say so in the PR.
4. **PR description**: what changed, how each acceptance criterion is met (one bullet per criterion), how you tested it, anything deferred.
5. **Never push to `main`.** All changes, including docs, land through a reviewed PR. Don't merge your own PR; O1 reviews and merges (Peter for O1's PRs).
6. **CI must be green** before review. Run `pnpm check` locally first.
7. **Review**: O1 reviews every PR against its acceptance criteria. Address every comment with a fix or a reply. After merge, post in the room: `T104 merged`.
8. **Blocked or spec unclear?** Ask in the room, addressed to O1. Don't guess on schema or protocol shape: those are shared contracts.

## Stack and decisions

These implement ARCHITECTURE §28. Lead decisions that refine it:

| Area          | Choice                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime       | Node 22 (≥ 22.18), TypeScript 6 strict, ESM only                                                                                                           |
| Monorepo      | pnpm workspaces: `packages/*` (libraries), `apps/*` (deployables)                                                                                          |
| Tests         | Vitest; files next to source as `*.test.ts`                                                                                                                |
| Lint / format | ESLint (typescript-eslint) + Prettier, enforced in CI                                                                                                      |
| Validation    | `zod` for every external input (commands, events, manifests)                                                                                               |
| Database      | PostgreSQL 16 via `pg`; plain SQL migrations (T102); no ORM                                                                                                |
| HTTP / WS     | Fastify + `@fastify/websocket`                                                                                                                             |
| Redis         | `ioredis`                                                                                                                                                  |
| IDs           | Prefixed ULIDs, e.g. `room_01J…` (T105)                                                                                                                    |
| Policy        | `authorize()` interface (T208) with a TypeScript rule set first; OPA-WASM (D9) replaces the implementation behind the same interface in a later milestone  |
| Git           | Git CLI ≥ 2.40 (refines ARCHITECTURE D1's 2.38: merge-tree --merge-base), via `execFile` (never a shell string)                                            |
| Pause         | `participants.pause` keeps tokens; every command returns `PARTICIPANT_PAUSED` and sockets close. Only `participants.remove` revokes tokens (refines §15.3) |
| Leases        | Renewed on each command and, for idle rooms, by `LeaseRenewer` every TTL/3 (T713); `onAcquire` runs on every acquisition before the first command          |

New runtime dependencies need a one-line justification in the PR.

## Package layout

| Package              | Owner | Contents                                                        |
| -------------------- | ----- | --------------------------------------------------------------- |
| `packages/protocol`  | S1    | Shared types, zod schemas, error codes, IDs, event catalog      |
| `packages/db`        | S1    | Pool, transactions, migration runner, SQL migrations, test DBs  |
| `packages/ledger`    | S1    | Event append/list, room leases, idempotency                     |
| `packages/policy`    | S1    | `authorize()`, capabilities, role bundles                       |
| `packages/kernel`    | S1/S2 | Room actor, dispatcher, domain modules (`src/modules/<domain>`) |
| `packages/workspace` | S2    | Git engine, ChangeSets, merge, conflicts, health                |
| `packages/gateway`   | S1    | REST + WebSocket                                                |
| `packages/mcp`       | S2    | MCP server                                                      |
| `apps/server`        | O1    | Composition root                                                |

Migrations live in `packages/db/migrations` and are numbered globally (`0001_…`). To avoid number collisions, each migration task names its number in the backlog; use exactly that number.

## Code standards

- Validate at the boundary, trust types inside. Every command handler takes zod-parsed params.
- Errors are `CrossoverError` with a code from ARCHITECTURE §16.3 (T114). Don't throw strings.
- Every mutation runs in one PostgreSQL transaction that also appends its events (§19.2). No state change without an event.
- Every SQL query that touches room data is scoped by `room_id`.
- Use parameterized queries only. Never build SQL or shell commands by string concatenation.
- No secrets in code, tests, fixtures or logs. Tokens are stored hashed.
- Tests: unit tests for logic; integration tests against real PostgreSQL (T103) for anything touching the DB. Concurrency claims (atomic claims, gap-free sequences) need a test that actually races.
- Public functions get a short doc comment when the name doesn't say it all. Reference the architecture section (`§8.3`) where it explains _why_.
- On every room lease acquisition (including failover), run workspace `reconcileRef(pool, roomId)` before the first command (§19.4, §26). T712 wires this through T713's lease-acquired hook; PostgreSQL history is authoritative, and failed recovery prevents activating that room. The hook repairs Git's cached ref without changing workspace rows or emitting events.

## Local setup

```sh
corepack enable
pnpm install
docker compose up -d   # PostgreSQL 16 + Redis 7
cp .env.example .env
pnpm check             # format, lint, typecheck, test
pnpm build && DEV_LOGIN=true WEB_ROOT=apps/web/dist/app pnpm --filter @crossover/server start   # migrate, serve the API and the web app on :8080
pnpm --filter @crossover/web dev   # the web app with hot reload on :5173, proxying /v1 to :8080
```

To run the server image with the sandbox Git topology, create the private network and fetcher image,
then set `GIT_INTERNAL_TOKEN_SECRET` and `DOCKER_GID` in `.env`. Generate the secret with
`openssl rand -hex 32` and read the socket group with `stat -c '%g' /var/run/docker.sock`.

```sh
docker network create --internal crossover-git
docker build -f apps/git-fetcher/Dockerfile -t crossover-git-fetcher:latest .
stat -c '%g' /var/run/docker.sock   # Set this numeric group ID as DOCKER_GID in .env.
openssl rand -hex 32                 # Set this value as GIT_INTERNAL_TOKEN_SECRET in .env.
workspace_root="${CROSSOVER_WORKSPACE_ROOT:-$PWD/.data/workspaces}"
sudo install -d -o 1000 -g 1000 -m 0750 "$workspace_root"
docker compose --profile server up --build -d
```

The server runs as the image's non-root `node` user, with `DOCKER_GID` added for socket access.
`CROSSOVER_WORKSPACE_ROOT` is mounted at the same absolute path inside and outside the container so
the host Docker daemon can mount canonical repositories into sandboxes.
The Compose server is for development and demos on a single host: sandboxes share the app host
through its Docker socket, unlike the separate sandbox hosts described in ARCHITECTURE §4.1.
