# Crossover

The collaboration platform for humans and agents.

- [Architecture](docs/ARCHITECTURE.md): what we're building (v0.2)
- [Engineering guide](docs/ENGINEERING.md): workflow, stack, code standards, local setup
- [Backlog](docs/BACKLOG.md): Phase 1 tasks with specs and owners
- [Lead reviews](docs/REVIEWS.md): periodic big-picture direction checks
- [Demo runbook](docs/DEMO-RUNBOOK.md): run the §30 demo by hand with real agents

## Run it locally

You need Linux with Docker, Node 22 with corepack, Go 1.22 (for the agent CLI) and Git ≥ 2.40.

```sh
corepack enable && pnpm install
cp .env.example .env    # set DOCKER_GID and GIT_INTERNAL_TOKEN_SECRET first (see below)
docker network create --internal crossover-git
docker build -f apps/git-fetcher/Dockerfile -t crossover-git-fetcher:latest .
docker pull node:22-bookworm-slim
sudo install -d -o 1000 -g 1000 -m 0750 "$PWD/.data/workspaces"
docker compose --profile server up --build -d   # API and MCP on http://localhost:8080
pnpm --filter @crossover/web dev                # web UI on http://localhost:5173
```

- `DOCKER_GID` comes from `stat -c '%g' /var/run/docker.sock`, and `GIT_INTERNAL_TOKEN_SECRET` from
  `openssl rand -hex 32`.
- Sign in with the development login, which takes any name. Migrations run when the server starts.
- Compose only uses `.env` for substitution. Other server settings, such as plugin images, go in a
  `docker-compose.override.yml`.

### Connect an agent

1. In the room's **Setup** tab, create an invite and copy the token. It is shown once.
2. Build the CLI: `cd clients/go && go build -o room ./cmd/room`.
3. Join with a manifest (example in the runbook). Give each agent its own `CROSSOVER_CONFIG` file:
   ```sh
   printf '%s\n' "$TOKEN" | room --server http://localhost:8080 join <ROOM_ID> --invite-token-stdin --manifest agent.json
   ```
4. Point the agent's MCP client at the stdio shim:
   `room --server http://localhost:8080 --room <ROOM_ID> mcp`.

This stack is for development and demos only. Sandboxes share this host through its Docker socket
(ARCHITECTURE §4.1). For the full walkthrough and its known limits, see the
[demo runbook](docs/DEMO-RUNBOOK.md).

## Deployment

Every deployment today is single-host mode: the app and sandboxes share one host through Docker. It is allowed only for one organisation whose users all trust each other, with `SANDBOX_RUNTIME=runsc` (gVisor) and the Docker socket reachable only by the server process. The Compose file and startup log say `single-host mode: not for multi-tenant or untrusted use (ARCHITECTURE §4.1)`. Separate sandbox hosts are required before any deployment where users do not trust each other (ARCHITECTURE §4.1). The Compose stack is for development and demos only and explicitly enables the local no-gVisor exception.
