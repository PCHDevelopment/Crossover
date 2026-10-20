# Hands-on demo runbook (ARCHITECTURE §30)

A manual run of the 17-step demo with real agents (Claude Code over MCP) against the local Docker
Compose stack. The automated version of this flow is `apps/server/src/e2e/web-demo-flow.ts`. That
test runs the server on the host and fakes GitHub. This runbook does neither, so it finds what the
test can't.

Write down every surprise as you go (step, what you did, what you expected, what happened). The log
format is at the end.

## Known limits before you start

- **Step 17 (export and pull request):** configure the GitHub App below before starting the stack.
  The owner connects it in Owner controls; the lead needs a `github.create_pull_request:<owner/repo>`
  capability grant to export a checkpoint as a pull request.
- **No network in sandboxes or health checks:** without the egress proxy, `npm install` can't run.
  Use a repository with no dependencies (below).
- **Capability grants are UI-only:** roles, pause and checkpoints have MCP tools; grant
  capabilities in the web UI as the owner.

## GitHub App setup for step 17

Create a GitHub App under **Settings → Developer settings → GitHub Apps**. Set repository
permissions to **Contents: Read and write**, **Pull requests: Read and write**, and **Metadata: Read-only**.
No webhook permissions or events are needed for this flow.

Set the App's **Callback URL** to
`<PUBLIC_ORIGIN>/v1/auth/github-app/callback` (for this local demo, `http://localhost:5173`, the
web UI origin that proxies `/v1`), then enable **Request user authorization
(OAuth) during installation**. GitHub disables the separate **Setup URL** field while that option is
enabled, so leave it blank; the callback verifies the installation, fetches its repositories, and
returns the owner to the room's repository picker ([callback URL docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url),
[setup URL docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)). The room-specific install start URL is
`<PUBLIC_ORIGIN>/v1/rooms/<ROOM_ID>/integrations/github/install`; owners launch it with
**Owner controls → Integrations → Connect GitHub**. Do not configure that per-room URL as the App's
Setup URL.

Set the following values in the local `.env` before starting or restarting the stack. Compose passes
these values into the server container; use literal `\n` sequences for PEM newlines so the key
stays on one `.env` line. The development stack requires `INTEGRATION_SECRET_KEY`; production uses
`INTEGRATION_KMS_KEY_ID` instead.

```dotenv
GITHUB_APP_ID=<numeric App ID>
GITHUB_APP_SLUG=<App slug from its GitHub URL>
GITHUB_CLIENT_ID=<App client ID>
GITHUB_CLIENT_SECRET=<App client secret>
GITHUB_APP_PRIVATE_KEY=<App private key PEM>
INTEGRATION_SECRET_KEY=<64 hex characters for local development>
```

Use KMS configuration for production instead of `INTEGRATION_SECRET_KEY`. Keep `.env` and the
private key out of Git. The callback exchanges the one-time code on the server, confirms that the
installation belongs to the authorizing GitHub user, lists repositories, and revokes the temporary
user token before presenting the picker.

## 0. Prepare a demo repository (once)

Create a **public** GitHub repository, for example `<you>/crossover-demo`, containing the files of
`scripts/compose-rehearsal/demo-repo/` in this repository (the nightly rehearsal imports a copy of
it and checks it equals that directory). In outline:

- `package.json`:
  ```json
  {
    "name": "crossover-demo",
    "private": true,
    "type": "module",
    "scripts": {
      "typecheck": "node --check index.js && node --check auth.js && node --check routes.js",
      "test": "node --test"
    }
  }
  ```
  (`node --check` takes one file; `node --check index.js auth.js routes.js` checks only `index.js`,
  so a syntax error in `auth.js` or `routes.js` would not turn the health check red.)
- `auth.js`: about 100 lines of plain JavaScript with a few exported functions. Step 7 needs lines
  40–62 to exist.
- `routes.js`: a small module that calls a function from `auth.js`.
- `index.js`: requires both.
- `auth.test.js`: a few `node:test` tests.

There must be no dependencies, no symlinks and no submodules. Import refuses the last two.

## 1. Start the stack

```sh
corepack enable && pnpm install
cp .env.example .env
#   in .env set:
#   DOCKER_GID=<output of: stat -c '%g' /var/run/docker.sock>
#   GIT_INTERNAL_TOKEN_SECRET=<output of: openssl rand -hex 32>
docker network create --internal crossover-git
docker build -f apps/git-fetcher/Dockerfile -t crossover-git-fetcher:latest .
docker pull node:22-bookworm-slim          # sandbox and health image; the first health run times out without it
sudo install -d -o 1000 -g 1000 -m 0750 "$PWD/.data/workspaces"
```

Compose uses `.env` for substitution and passes the GitHub App and integration-secret settings
listed above into the server container. Other extra server settings go in
`docker-compose.override.yml`, which Compose loads automatically. Step 14 needs the AWS tool
registered. Its image never runs, because policy denies the call first. Find the pinned reference:

```sh
docker inspect --format '{{index .RepoDigests 0}}' node:22-bookworm-slim   # node@sha256:...
```

```yaml
# docker-compose.override.yml (not committed)
services:
  server:
    environment:
      AWS_PLUGIN_IMAGE: node@sha256:<digest from above>
```

Then:

```sh
docker compose --profile server up --build -d       # Postgres, Redis, server on :8080; migrations run at start
docker compose logs -f server                       # watch for errors throughout the run
pnpm --filter @crossover/web dev                    # web UI on http://localhost:5173 (proxies /v1 and /mcp to :8080)
```

Build the agent CLI:

```sh
cd clients/go && CGO_ENABLED=0 go build -buildvcs=false -o room ./cmd/room && sudo install room /usr/local/bin/
```

The same steps run nightly, without a browser, against the real Compose stack: the `compose-rehearsal`
job in `.github/workflows/ci.yml` (`scripts/compose-rehearsal/`). It follows this section literally and
then drives steps 1-7 (steps 8-16 follow); step 17 needs a real GitHub App and is not rehearsed.

## 2. Connect four agents (steps 1–3)

1. **Step 1:** open http://localhost:5173, sign in with any name (development login), and create
   **Project Alpha** with an objective.
2. **Step 2:**
   - Go to Setup, enter `https://github.com/<you>/crossover-demo` with branch `main`, and import.
   - **Expect:** the suggested health command `npm run typecheck && npm test`.
   - Click "Use suggestion".
3. **Step 3:**
   - In Setup, create four DEVELOPER invites. Copy each token when it is shown; it is shown once.
   - Copy the room id from the URL or the Setup page.
   - For each agent (`architect`, `agent-a`, `agent-b`, `agent-c`):
     - Write a manifest `<name>.json`:
       ```json
       {
         "name": "ArchitectAgent",
         "operator": { "name": "Peter", "contact": "peter@example.com" },
         "vendor": "Anthropic",
         "model": "claude",
         "client": "mcp",
         "client_version": "1",
         "description": "Lead for the demo"
       }
       ```
     - Join with its own config file, so the agents don't overwrite each other's tokens:
       ```sh
       export CROSSOVER_CONFIG=$HOME/.config/crossover/<name>.json
       printf '%s\n' "<invite token>" | room --server http://localhost:8080 join <ROOM_ID> --invite-token-stdin --manifest <name>.json
       ```
     - Open a separate terminal and directory for each agent, and register the MCP server in Claude
       Code there. This is Claude Code's syntax, not ours; check `claude mcp add --help`.
       ```sh
       claude mcp add crossover -e CROSSOVER_CONFIG=$HOME/.config/crossover/<name>.json -- room --server http://localhost:8080 --room <ROOM_ID> mcp
       ```
   - **Expect:** all four agents in the Overview participant list, and `room_get_state` works from
     each Claude Code session.

## 3. The demo (steps 4–17)

Give each Claude Code session a short role prompt ("You are ArchitectAgent, the room lead. Use the
crossover MCP tools.") and ask for each step in plain words. The tool names are listed in brackets.

| #   | Who / where                      | Do                                                                                                                                                                                                                                     | Expect                                                                                   |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 4   | Peter, Setup                     | Appoint ArchitectAgent as lead. Change your own role to Developer in Owner controls; if the UI refuses, note it.                                                                                                                       | Lead badge on ArchitectAgent.                                                            |
| 5   | Lead and agents                  | Lead proposes "session tokens vs JWT" (`decisions_propose`); A and B add positions (`decisions_add_position`); lead decides (`decisions_decide`).                                                                                      | The decision under "Inbox, decisions & memory", mirrored to memory `decisions/…`.        |
| 6   | Lead                             | Create four tasks with a reviewer (`tasks_create`), assign them (`tasks_assign`); A and B claim and start theirs (`tasks_claim`, `tasks_start`).                                                                                       | Tasks tab shows the owners and states.                                                   |
| 7   | Peter, Files; Agent A            | Open `auth.js`. Agent A sets an edit intent on lines 40–62 of `auth.js` (`presence_set_intent`).                                                                                                                                       | The intent is marked in your editor.                                                     |
| 8   | A and B                          | Edit in their sandboxes (`sandbox_write_file`, `sandbox_exec` running `node --test`).                                                                                                                                                  | A sandbox container appears (`docker ps`); exec output streams.                          |
| 9   | Peter, Files                     | Edit a different part of `auth.js`, e.g. rename a helper that `routes.js` uses.                                                                                                                                                        | Your draft flushes within seconds; agents can read it.                                   |
| 10  | Agent A                          | `sandbox_sync`, then `submit_changes`.                                                                                                                                                                                                 | A clean merge; the diff shows in Changes.                                                |
| 11  | Agent C                          | Ask C to apply an overlapping change from a stale base on purpose (`apply_changeset` with an old base revision).                                                                                                                       | A CONFLICT, sent to C.                                                                   |
| 12  | C, then lead                     | C syncs and tries twice to resolve it with stale content; then the lead resolves it (`apply_changeset`, source RESOLUTION).                                                                                                            | It escalates to the lead's inbox and is then resolved.                                   |
| 13  | Agent B                          | B uses the helper Peter renamed.                                                                                                                                                                                                       | Health turns RED; B gets an inbox item (`inbox_list`), fixes it, and health turns GREEN. |
| 14  | Agent B                          | `tools_invoke` with `aws.deploy_lambda` and function `prod-api`.                                                                                                                                                                       | Denied; the denial shows in Activity.                                                    |
| 15  | Peter, Overview                  | Pause Agent C, try an action as C, then resume.                                                                                                                                                                                        | C's action is refused while paused.                                                      |
| 16  | A/B, then lead                   | `tasks_submit` with evidence; the lead approves (`tasks_review`, approve).                                                                                                                                                             | Tasks done; health GREEN.                                                                |
| 17  | Peter, Owner controls, then lead | Connect the GitHub App, select the demo repository, and grant ArchitectAgent `github.create_pull_request:<owner/repo>` in Owner controls. Create a checkpoint, then have the lead call `checkpoints_export` with a pull-request title. | The checkpoint is pushed to `room/<slug>` and the pull request opens against `main`.     |

## 4. Log format

Post the log as a comment on the demo-run issue, or send it to O1 here. One line per finding:

```
step | severity (blocker / wrong / rough / note) | what I did | expected | actual | log or screenshot
```

Severity:

- **blocker:** you couldn't continue the step.
- **wrong:** the result was incorrect.
- **rough:** it worked, but was confusing or slow.
- **note:** anything else.

## Enable Zoekt search

To serve current-head searches from the local Zoekt sidecar, start the server profile with
`SEARCH_BACKEND=zoekt docker compose --profile server up -d`. Keep the shared index directory
configured as in `docker-compose.yml`. The server log line `workspace.search backend: zoekt`
shows an indexed response; `workspace.search backend: ripgrep` means the index was unavailable
or had not reached the DB head. Historical revision searches continue through Git grep.

## Rebuild the derived memory index

With the server profile running (`docker compose --profile server up -d`), run the rebuild inside the container, enabling the provider for that process:

```sh
docker compose exec -e MEMORY_SEARCH_PROVIDER=local-hash server node /app/dist/rebuild-memory-index.js --room <room_id>
docker compose exec -e MEMORY_SEARCH_PROVIDER=local-hash server node /app/dist/rebuild-memory-index.js --all
```

The command reports room counts and success/error codes, never memory values.
