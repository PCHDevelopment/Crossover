import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CrossoverClient } from "@crossover/sdk";
import { it } from "vitest";
import {
  assertNoLeaks,
  BASE_URL,
  errorText,
  OUT_DIR,
  REPO_ROOT,
  secret,
  secretsFromJsonFile,
  serverLogTail,
  step,
  summary,
  waitFor,
} from "./harness.js";
import { connectAgent, type AgentMcp } from "./mcp.js";

const execFileAsync = promisify(execFile);

// docs/DEMO-RUNBOOK.md is the spec; this file follows its section 1 (done by the CI job) and the
// steps 1-16 of section 3. Step 17 needs a real GitHub App and is out of scope.
const DEMO_REPO_URL =
  process.env["DEMO_REPO_URL"] ?? "https://github.com/PCHDevelopment/crossover-demo";
const FIXTURE = fileURLToPath(new URL("./demo-repo", import.meta.url));
const ROOM_BIN = process.env["ROOM_BIN"] ?? "room";
const UI_URL = "http://localhost:5173";
// Measured (T1570): idle runner, 3 green runs, per step 12 to 1,526 ms (step 0b the slowest, it starts
// Vite); budget = max x 7 rounded up to the next 5,000 ms, minimum 15,000 (the T1529 rule), so 15 s.
const STEP_MS = 15_000;
// Docker work (steps 8, 10) and health runs (step 13) start from the budgets of the in-process demo flow
// (web-demo-flow.ts); they are replaced by measured values (max x 7) once part B has run three times.
const DOCKER_MS = 150_000;
const HEALTH_MS = 150_000;
// A request that never answers must not outlive the step: every fetch in this file is cut off here.
const REQUEST_MS = 3_000;

interface Participant {
  id: string;
  display_name: string;
  status: string;
}
interface RoomState {
  sections: {
    participants: Participant[];
    room: { lead_participant_id: string | null; settings: Record<string, unknown> | null };
  };
}
interface FileView {
  content: string;
  workspace_revision: number;
  file_revision: number;
}
interface RoomEvent {
  type: string;
  payload: Record<string, unknown>;
}
interface TaskView {
  id: string;
  version: number;
  status: string;
  owner_id?: string | null;
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; allowFail?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (!options.allowFail) throw error;
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

/** `room join` the way the runbook does it: the invite token on stdin, one config file per agent. */
function joinWithCli(
  roomId: string,
  token: string,
  configPath: string,
  manifestPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ROOM_BIN,
      ["--server", BASE_URL, "join", roomId, "--invite-token-stdin", "--manifest", manifestPath],
      { env: { ...process.env, CROSSOVER_CONFIG: configPath }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`room join exited ${code}: ${output.slice(-300)}`)),
    );
    child.stdin.end(`${token}\n`);
  });
}

/** Stop a detached child and everything it started (Vite is a process group), ignoring a child that is gone. */
function stopGroup(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
}

const manifestFor = (name: string) => ({
  name,
  operator: { name: "Peter", contact: "peter@example.com" },
  vendor: "Anthropic",
  model: "claude",
  client: "mcp",
  client_version: "1",
  description: `${name} in the compose rehearsal`,
});

it("rehearses docs/DEMO-RUNBOOK.md steps 1-16 against the real docker compose stack", async () => {
  await mkdir(OUT_DIR, { recursive: true });
  if (process.env["GIT_INTERNAL_TOKEN_SECRET"])
    secret("GIT_INTERNAL_TOKEN_SECRET", process.env["GIT_INTERNAL_TOKEN_SECRET"]);
  const agents: AgentMcp[] = [];
  // Step 0b's Vite, also stopped below if the step's own timer ends the step before its callback does.
  let vite: ChildProcess | undefined;
  let failure: unknown;
  try {
    // 0. The demo repository the runbook imports (section 0) is the fixture kept in this repository.
    await step(
      {
        id: "0",
        title: "the demo repository equals scripts/compose-rehearsal/demo-repo",
        expectation: `${DEMO_REPO_URL} (main) has exactly the files of the fixture`,
        budgetMs: STEP_MS,
      },
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "rehearsal-demo-"));
        await run("git", ["clone", "--depth=1", "--quiet", "--branch", "main", DEMO_REPO_URL, dir]);
        const diff = await run("diff", ["-r", "-q", "--exclude=.git", dir, FIXTURE], {
          allowFail: true,
        });
        if (diff.code !== 0) throw new Error(`it differs from the fixture:\n${diff.stdout}`);
        return `${DEMO_REPO_URL} equals the fixture`;
      },
    );

    // 0b. The development UI proxies /v1 and /mcp to the server (T1535 broke /mcp).
    await step(
      {
        id: "0b",
        title: "the dev UI (Vite) proxies /v1 and /mcp to the server",
        expectation: `${UI_URL}/mcp and ${UI_URL}/v1/... answer as ${BASE_URL} does`,
        budgetMs: STEP_MS,
      },
      async () => {
        vite = spawn("pnpm", ["--filter", "@crossover/web", "dev"], {
          cwd: REPO_ROOT,
          stdio: "ignore",
          detached: true,
        });
        try {
          await waitFor(
            "the Vite dev server",
            async () =>
              (await fetch(`${UI_URL}/`, { signal: AbortSignal.timeout(REQUEST_MS) })).status,
            (status) => status === 200,
            // Vite is up in about 1.4 s (3 runs): 7x is 10 s, which leaves the rest of the step's 15 s for
            // the two proxy checks, and this wait reports what it last saw before the step's budget does.
            10_000,
          );
          const providers = async (base: string) => {
            const response = await fetch(`${base}/v1/auth/providers`, {
              signal: AbortSignal.timeout(REQUEST_MS),
            });
            return { status: response.status, body: await response.text() };
          };
          const direct = await providers(BASE_URL);
          const viaUi = await providers(UI_URL);
          if (direct.status !== 200 || viaUi.status !== direct.status || viaUi.body !== direct.body)
            throw new Error(
              `GET /v1/auth/providers: server ${direct.status}, UI ${viaUi.status}; bodies ${
                viaUi.body === direct.body ? "equal" : "differ"
              }`,
            );
          const initialize = JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "proxy-check", version: "1" },
            },
          });
          const mcp = async (base: string) => {
            const response = await fetch(`${base}/mcp`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
              body: initialize,
              signal: AbortSignal.timeout(REQUEST_MS),
            });
            return { status: response.status, type: response.headers.get("content-type") ?? "" };
          };
          const mcpDirect = await mcp(BASE_URL);
          const mcpViaUi = await mcp(UI_URL);
          if (
            mcpViaUi.status !== mcpDirect.status ||
            mcpViaUi.type !== mcpDirect.type ||
            mcpViaUi.type.includes("html")
          )
            throw new Error(
              `POST /mcp: server ${mcpDirect.status} ${mcpDirect.type}, UI ${mcpViaUi.status} ${mcpViaUi.type}`,
            );
          return `/v1 and /mcp reach the server through :5173 (POST /mcp -> ${mcpViaUi.status})`;
        } finally {
          stopGroup(vite);
        }
      },
    );

    // 1. Peter signs in (development login) and creates Project Alpha.
    const client = new CrossoverClient({ baseUrl: BASE_URL });
    let roomId = "";
    let owner!: ReturnType<CrossoverClient["room"]>;
    let ownerId = "";
    await step(
      {
        id: "1",
        title: "Peter creates Project Alpha",
        expectation: "the room exists and its owner is a participant",
        budgetMs: STEP_MS,
      },
      async () => {
        const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
        if (!login.session_token)
          throw new Error("the development login returned no session token");
        secret("owner session token", login.session_token);
        const slug = `project-alpha-${Date.now().toString(36)}`;
        const created = await client.createRoom(login.session_token, {
          slug,
          name: "Project Alpha",
          objective: "Ship the login",
        });
        roomId = created.response.room.id;
        const session = await client.roomSession(login.session_token, roomId);
        secret("owner access token", session.tokens.access_token);
        if (session.tokens.refresh_token)
          secret("owner refresh token", session.tokens.refresh_token);
        owner = client.room(roomId, session.tokens);
        ownerId = session.participant_id;
        const state = (await owner.api.room.get_state<RoomState>({ view: "summary" })).response;
        if (!state.sections.participants.some((participant) => participant.id === ownerId))
          throw new Error("the owner is not in the participant list");
        return `room ${roomId}, owner ${ownerId}`;
      },
    );

    // 2. Peter imports the demo repository and takes its health-command suggestion.
    await step(
      {
        id: "2",
        title: "Peter imports the repository and selects its health command",
        expectation: "the suggestion is `npm run typecheck && npm test`, and it can be saved",
        budgetMs: STEP_MS,
      },
      async () => {
        const imported = (
          await owner.api.git.import<{
            suggested_health_command: { command: string } | null;
          }>({ url: DEMO_REPO_URL, branch: "main" })
        ).response;
        const suggestion = imported.suggested_health_command?.command;
        if (suggestion !== "npm run typecheck && npm test")
          throw new Error(`the suggested health command was ${JSON.stringify(suggestion)}`);
        await owner.api.room.set_health({ health_command: suggestion });
        const saved = (await owner.api.room.get_state<RoomState>({ view: "summary" })).response
          .sections.room.settings?.["health_command"];
        if (saved !== suggestion) throw new Error(`the saved health command was ${String(saved)}`);
        return `suggestion ${JSON.stringify(suggestion)} saved`;
      },
    );

    // 3. Four DEVELOPER invites; each agent joins with the Go CLI and its own config file.
    const names = ["ArchitectAgent", "AgentA", "AgentB", "AgentC"];
    const agentDir = await mkdtemp(join(tmpdir(), "rehearsal-agents-"));
    const configOf = (name: string) => join(agentDir, `${name}.config.json`);
    const byName = new Map<string, string>();
    await step(
      {
        id: "3",
        title: "four invites; the four agents join with `room join`",
        expectation: "all four agents are in the participant list",
        budgetMs: STEP_MS,
      },
      async () => {
        for (const name of names) {
          const invite = (await owner.api.room.invite<unknown>({
            role: "DEVELOPER",
          })) as unknown as {
            one_time: { token: string };
          };
          const token = secret(`invite token for ${name}`, invite.one_time.token);
          const manifestPath = join(agentDir, `${name}.manifest.json`);
          await writeFile(manifestPath, JSON.stringify(manifestFor(name)));
          await joinWithCli(roomId, token, configOf(name), manifestPath);
          await secretsFromJsonFile(`${name} config`, configOf(name));
        }
        const state = (await owner.api.room.get_state<RoomState>({ view: "summary" })).response;
        for (const name of names) {
          const found = state.sections.participants.find(
            (participant) => participant.display_name === name,
          );
          if (!found) throw new Error(`${name} is not in the participant list`);
          byName.set(name, found.id);
        }
        for (const name of names) agents.push(await connectAgent(name, configOf(name), roomId));
        return `${names.length} agents joined; MCP tools listed: ${agents[0]!.tools.length}`;
      },
    );
    const agent = (name: string) => agents.find((candidate) => candidate.name === name)!;
    const idOf = (name: string) => byName.get(name)!;

    // 4. Peter appoints ArchitectAgent as lead.
    await step(
      {
        id: "4",
        title: "Peter appoints ArchitectAgent as lead",
        expectation: "ArchitectAgent is the room's lead",
        budgetMs: STEP_MS,
      },
      async () => {
        await owner.api.room.set_lead({ participant_id: idOf("ArchitectAgent") });
        await owner.api.participants.set_role({ participant_id: ownerId, role: "DEVELOPER" });
        const lead = (await owner.api.room.get_state<RoomState>({ view: "summary" })).response
          .sections.room.lead_participant_id;
        if (lead !== idOf("ArchitectAgent")) throw new Error(`the lead is ${String(lead)}`);
        return "ArchitectAgent is lead; Peter is a DEVELOPER";
      },
    );

    // 5. The lead proposes and decides over MCP; A and B add positions; the decision is mirrored.
    await step(
      {
        id: "5",
        title: "agents decide tokens versus JWT (MCP); the decision is mirrored to memory",
        expectation: "memory decisions/<id> holds the accepted decision",
        budgetMs: STEP_MS,
      },
      async () => {
        const architect = agent("ArchitectAgent");
        await architect.call("decisions_propose", {
          title: "Session tokens or JWT",
          context: "Choose the authentication format for Project Alpha.",
          options: [
            { summary: "Session tokens", detail: "Use server-managed sessions." },
            { summary: "JWT", detail: "Use signed self-contained tokens." },
          ],
        });
        const listed = (
          await owner.api.decisions.list<{ decisions: { id: string; title: string }[] }>({
            limit: 100,
          })
        ).response.decisions;
        const decisionId = listed.find((item) => item.title === "Session tokens or JWT")?.id;
        if (!decisionId) throw new Error("the proposed decision is not listed");
        await agent("AgentA").call("decisions_add_position", {
          decision_id: decisionId,
          option_id: "opt_1",
          argument: "Server-managed sessions are easy to revoke.",
        });
        await agent("AgentB").call("decisions_add_position", {
          decision_id: decisionId,
          option_id: "opt_2",
          argument: "JWT supports stateless API consumers.",
        });
        const current = await architect.call<{ version: number }>("decisions_get", {
          decision_id: decisionId,
        });
        await architect.call("decisions_decide", {
          decision_id: decisionId,
          expected_version: current.version,
          outcome_option_id: "opt_1",
          rationale: "Revocation and the current server architecture favor sessions.",
        });
        const mirrored = await waitFor(
          `memory decisions/${decisionId}`,
          async () =>
            (await owner.api.memory.get<{ value: string }>({ key: `decisions/${decisionId}` }))
              .response.value,
          (value) => value.includes("Session tokens or JWT") && value.includes("ACCEPTED"),
          20_000,
        );
        return `decision ${decisionId} accepted and mirrored (${mirrored.length} bytes)`;
      },
    );

    // 6. The lead creates four reviewed tasks and assigns two; A and B claim and start theirs.
    const tasks: TaskView[] = [];
    await step(
      {
        id: "6",
        title: "the lead creates and assigns four tasks (MCP); A and B claim and start",
        expectation: "two tasks IN_PROGRESS and two CLAIMED, with the owners the runbook gives",
        budgetMs: STEP_MS,
      },
      async () => {
        const architect = agent("ArchitectAgent");
        for (const title of [
          "Session tokens",
          "API routes",
          "Conflict handling",
          "Health verification",
        ])
          tasks.push(
            await architect.call<TaskView>("tasks_create", {
              title,
              requirements: ["Complete the Project Alpha walkthrough work."],
              reviewer_id: idOf("ArchitectAgent"),
              review_required: true,
            }),
          );
        const assignedA = await architect.call<TaskView>("tasks_assign", {
          task_id: tasks[0]!.id,
          expected_version: tasks[0]!.version,
          participant_id: idOf("AgentA"),
        });
        const assignedB = await architect.call<TaskView>("tasks_assign", {
          task_id: tasks[1]!.id,
          expected_version: tasks[1]!.version,
          participant_id: idOf("AgentB"),
        });
        await agent("AgentA").call("tasks_claim", {
          task_id: tasks[2]!.id,
          expected_version: tasks[2]!.version,
        });
        await agent("AgentB").call("tasks_claim", {
          task_id: tasks[3]!.id,
          expected_version: tasks[3]!.version,
        });
        await agent("AgentA").call("tasks_start", {
          task_id: tasks[0]!.id,
          expected_version: assignedA.version,
        });
        await agent("AgentB").call("tasks_start", {
          task_id: tasks[1]!.id,
          expected_version: assignedB.version,
        });
        const listed = (await owner.api.tasks.list<{ tasks: TaskView[] }>({})).response.tasks;
        const status = (task: TaskView) => listed.find((item) => item.id === task.id)?.status;
        const observed = tasks.map(status);
        const expected = ["IN_PROGRESS", "IN_PROGRESS", "CLAIMED", "CLAIMED"];
        if (JSON.stringify(observed) !== JSON.stringify(expected))
          throw new Error(
            `task states ${JSON.stringify(observed)}, expected ${JSON.stringify(expected)}`,
          );
        return `4 tasks: ${observed.join(", ")}`;
      },
    );

    // 7. Agent A announces an edit intent on auth.js lines 40-62.
    await step(
      {
        id: "7",
        title: "Agent A sets an edit intent on auth.js lines 40-62 (MCP)",
        expectation: "presence.list_intents shows A's intent on those lines",
        budgetMs: STEP_MS,
      },
      async () => {
        await agent("AgentA").call("presence_set_intent", {
          paths: ["auth.js"],
          ranges: [{ path: "auth.js", start_line: 40, end_line: 62 }],
          task_id: tasks[0]!.id,
        });
        const intents = await waitFor(
          "A's edit intent",
          async () =>
            (
              await owner.api.presence.list_intents<{
                intents: {
                  participant_id: string;
                  ranges: { path: string; start_line: number; end_line: number }[];
                }[];
              }>({})
            ).response.intents,
          (list) =>
            list.some(
              (intent) =>
                intent.participant_id === idOf("AgentA") &&
                intent.ranges.some(
                  (range) =>
                    range.path === "auth.js" && range.start_line === 40 && range.end_line === 62,
                ),
            ),
          15_000,
        );
        return `${intents.length} intent(s); A holds auth.js 40-62`;
      },
    );

    const read = async (path: string) =>
      (await owner.api.workspace.read<FileView>({ path })).response;
    const roomEvents = async () =>
      (await owner.api.room.events.list<{ events: RoomEvent[] }>({ limit: 500 })).response.events;
    const healthOf = async (revision: number) =>
      (await roomEvents()).find(
        (event) => event.type === "workspace.health" && event.payload["revision"] === revision,
      );
    const versionOf = async (task: TaskView) =>
      (await owner.api.tasks.list<{ tasks: TaskView[] }>({})).response.tasks.find(
        (item) => item.id === task.id,
      )!.version;
    // The one line the agents fight over: inside Agent A's intent (lines 40-62 of auth.js).
    const MARK = "or null when it is. */";
    const mark = (content: string, from: string, to: string) => {
      if (!content.includes(from)) throw new Error(`auth.js has no ${JSON.stringify(from)}`);
      return content.replace(from, to);
    };
    const initialAuth = await read("auth.js");

    // Run a command in an agent's sandbox over MCP and read its output stream as the owner does.
    const execIn = async (who: string, command: string) => {
      const started = await agent(who).call<{ exec_id: string }>("sandbox_exec", {
        command,
        timeout_s: 60,
      });
      let text = "";
      let exitCode: number | null | undefined;
      const stream = owner.subscribeSandboxOutput(started.exec_id, {
        onUpdate: (update) => {
          if (update.kind === "data") text += new TextDecoder().decode(update.data);
          if (update.kind === "finished") exitCode = update.exit_code;
        },
      });
      try {
        await waitFor(
          `${who}'s \`${command}\` to end`,
          async () => exitCode,
          (code) => code !== undefined,
          60_000,
        );
      } finally {
        stream.close();
      }
      return { exitCode, text };
    };

    // 8. A and B work in real sandboxes: a container per agent, output streamed, exit code recorded.
    await step(
      {
        id: "8",
        title: "A and B edit in their sandboxes and run `node --test` (MCP)",
        expectation:
          "a sandbox container exists (docker ps), the output streams and the exit code is 0",
        budgetMs: DOCKER_MS,
      },
      async () => {
        // The first sandbox_exec creates an agent's sandbox (a write before it has nothing to write to).
        await Promise.all([execIn("AgentA", "node --version"), execIn("AgentB", "node --version")]);
        await agent("AgentA").call("sandbox_write_file", {
          path: "auth.js",
          content: mark(initialAuth.content, MARK, "or null when it is (A). */"),
        });
        await agent("AgentB").call("sandbox_write_file", {
          path: "refresh.js",
          content:
            'import { createSessionToken } from "./auth.js";\n\nexport function refreshHandler(userId) {\n  return { status: 200, token: createSessionToken(userId) };\n}\n',
        });
        await agent("AgentB").call("sandbox_write_file", {
          path: "refresh.test.js",
          content:
            'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { refreshHandler } from "./refresh.js";\n\ntest("refreshing returns a token", () => {\n  assert.equal(refreshHandler("Ada").token, "token:ada");\n});\n',
        });
        const tested = await execIn("AgentB", "node --test");
        if (tested.exitCode !== 0)
          throw new Error(
            `node --test exited ${String(tested.exitCode)}: ${tested.text.slice(-300)}`,
          );
        if (!tested.text.includes("pass"))
          throw new Error(
            `no test output was streamed: ${JSON.stringify(tested.text.slice(-200))}`,
          );
        const text = tested.text;
        const containers = (
          await run("docker", ["ps", "--filter", "label=crossover.sandbox=true", "-q"])
        ).stdout
          .split("\n")
          .filter(Boolean);
        if (containers.length === 0)
          throw new Error("docker ps shows no container with the label crossover.sandbox=true");
        return `${containers.length} sandbox container(s); ${text.length} bytes streamed; exit 0`;
      },
    );

    // 9. Peter renames the helper (the editor's flush is this EDITOR ChangeSet); agents can read it.
    await step(
      {
        id: "9",
        title: "Peter renames createSessionToken; the draft flushes and agents can read it",
        expectation: "the canonical auth.js has createAccessToken and an agent reads it",
        budgetMs: STEP_MS,
      },
      async () => {
        const files = await Promise.all(["auth.js", "routes.js", "auth.test.js"].map(read));
        const operations = files.map((file, index) => ({
          type: "modify" as const,
          path: ["auth.js", "routes.js", "auth.test.js"][index]!,
          content: file.content.replaceAll("createSessionToken", "createAccessToken"),
        }));
        const flushed = (
          await owner.api.workspace.apply_changeset<{ status: string }>({
            source: "EDITOR",
            message: "Rename createSessionToken to createAccessToken",
            base_workspace_revision: files[0]!.workspace_revision,
            base_file_revisions: Object.fromEntries(
              files.map((file, index) => [operations[index]!.path, file.file_revision]),
            ),
            operations,
          })
        ).response;
        if (flushed.status !== "APPLIED") throw new Error(`the flush was ${flushed.status}`);
        const seen = await agent("AgentA").call<{ content: string }>("read_file", {
          path: "auth.js",
        });
        if (!seen.content.includes("createAccessToken"))
          throw new Error("Agent A does not see the renamed helper");
        return "renamed in auth.js, routes.js and auth.test.js; Agent A reads it";
      },
    );

    // 10. A syncs (a clean rebase over Peter's rename) and submits; the merge keeps both edits.
    await step(
      {
        id: "10",
        title: "Agent A syncs and submits (MCP)",
        expectation: "a clean merge: the ChangeSet is applied and auth.js holds both edits",
        budgetMs: DOCKER_MS,
      },
      async () => {
        const current = await read("auth.js");
        const synced = await agent("AgentA").call<{
          synced_to: number;
          conflicted_paths?: string[];
        }>("sandbox_sync", {});
        if (synced.synced_to !== current.workspace_revision || synced.conflicted_paths?.length)
          throw new Error(`sandbox_sync: ${JSON.stringify(synced)}`);
        const submitted = await agent("AgentA").call<{ status: string; applied_revision: number }>(
          "submit_changes",
          { paths: ["auth.js"], message: "Document the password rule", task_id: tasks[0]!.id },
        );
        if (submitted.status !== "APPLIED") throw new Error(`submit_changes: ${submitted.status}`);
        const merged = (await read("auth.js")).content;
        if (!merged.includes("createAccessToken") || !merged.includes("(A)"))
          throw new Error("auth.js does not hold both Peter's rename and Agent A's edit");
        return `applied at revision ${submitted.applied_revision}; both edits present`;
      },
    );

    // 11. C applies an overlapping change from the original (stale) base.
    let conflictId = "";
    let afterA!: FileView;
    await step(
      {
        id: "11",
        title: "Agent C applies an overlapping ChangeSet from a stale base",
        expectation: "CONFLICT, with A's ChangeSet as the counterparty",
        budgetMs: STEP_MS,
      },
      async () => {
        afterA = await read("auth.js");
        const submitted = await agent("AgentC").call<{
          status: string;
          conflict_id: string;
          counterparty_changesets: string[];
        }>("apply_changeset", {
          source: "API",
          message: "Agent C conflicts with Agent A",
          base_workspace_revision: initialAuth.workspace_revision,
          base_file_revisions: { "auth.js": initialAuth.file_revision },
          operations: [
            {
              type: "modify",
              path: "auth.js",
              content: mark(initialAuth.content, MARK, "or null when it is (C). */"),
            },
          ],
        });
        if (submitted.status !== "CONFLICT") throw new Error(`status ${submitted.status}`);
        if (!submitted.counterparty_changesets?.length) throw new Error("no counterparty");
        conflictId = submitted.conflict_id;
        return `conflict ${conflictId}`;
      },
    );

    // 12. C's two resolutions go stale (B and A edit the line again), so it escalates to the lead.
    await step(
      {
        id: "12",
        title: "C syncs and tries twice with stale content; the lead resolves",
        expectation: "ESCALATED, an ESCALATION item in the lead's inbox, then RESOLVED",
        budgetMs: STEP_MS * 4,
      },
      async () => {
        await agent("AgentC").call("sandbox_sync", {});
        const apply = (who: string, content: string, base: FileView, extra = {}) =>
          agent(who).call<{ status: string; conflict_id: string }>("apply_changeset", {
            message: `${who} edits auth.js`,
            base_workspace_revision: base.workspace_revision,
            base_file_revisions: { "auth.js": base.file_revision },
            operations: [{ type: "modify", path: "auth.js", content }],
            source: "API",
            ...extra,
          });
        const resolution = (who: string, content: string, base: FileView) =>
          apply(who, content, base, { source: "RESOLUTION", conflict_id: conflictId });
        const raceOne = await apply("AgentB", mark(afterA.content, "(A)", "(A, B)"), afterA);
        if (raceOne.status !== "APPLIED") throw new Error(`B's edit was ${raceOne.status}`);
        const failedOne = await resolution(
          "AgentC",
          mark(afterA.content, "(A)", "(A, C1)"),
          afterA,
        );
        if (failedOne.status !== "CONFLICT") throw new Error(`attempt one: ${failedOne.status}`);
        const afterB = await read("auth.js");
        const raceTwo = await apply("AgentA", mark(afterB.content, "(A, B)", "(A, B, A2)"), afterB);
        if (raceTwo.status !== "APPLIED") throw new Error(`A's edit was ${raceTwo.status}`);
        const failedTwo = await resolution(
          "AgentC",
          mark(afterB.content, "(A, B)", "(A, C2)"),
          afterB,
        );
        if (failedTwo.status !== "CONFLICT") throw new Error(`attempt two: ${failedTwo.status}`);
        const lead = agent("ArchitectAgent");
        const conflict = await lead.call<{ status: string; attempts: number }>("conflicts_get", {
          conflict_id: conflictId,
        });
        if (conflict.status !== "ESCALATED" || conflict.attempts !== 2)
          throw new Error(`conflict ${JSON.stringify(conflict)}`);
        const inbox = await lead.call<{ items: { kind: string; ref: { id: string } }[] }>(
          "inbox_list",
          { unacked_only: true },
        );
        if (!inbox.items.some((item) => item.kind === "ESCALATION" && item.ref.id === conflictId))
          throw new Error("no ESCALATION item for the conflict in the lead's inbox");
        const latest = await read("auth.js");
        const resolved = await resolution("ArchitectAgent", latest.content, latest);
        if (resolved.status !== "APPLIED")
          throw new Error(`the lead's resolution was ${resolved.status}`);
        const after = await lead.call<{ status: string }>("conflicts_get", {
          conflict_id: conflictId,
        });
        if (after.status !== "RESOLVED") throw new Error(`conflict is ${after.status}`);
        return "two stale attempts -> ESCALATED -> lead's RESOLUTION -> RESOLVED";
      },
    );

    // 13. B syncs and submits code that uses the old helper name: health goes RED, then GREEN.
    await step(
      {
        id: "13",
        title: "B uses the renamed helper's old name: health RED, B's inbox, the fix, GREEN",
        expectation: "a real Docker health run is RED, B gets HEALTH_RED, the fix runs GREEN",
        budgetMs: HEALTH_MS * 2 + 30_000,
      },
      async () => {
        const b = agent("AgentB");
        await b.call("sandbox_sync", {});
        const broken = await b.call<{ status: string; applied_revision: number }>(
          "submit_changes",
          {
            paths: ["refresh.js", "refresh.test.js"],
            message: "Add a refresh route",
            task_id: tasks[1]!.id,
          },
        );
        if (broken.status !== "APPLIED") throw new Error(`B's submit was ${broken.status}`);
        const red = await waitFor(
          `the health run for revision ${broken.applied_revision}`,
          () => healthOf(broken.applied_revision),
          (event) => event !== undefined && event.payload["status"] !== "RUNNING",
          HEALTH_MS,
        );
        if (red?.payload["status"] !== "RED")
          throw new Error(`health was ${String(red?.payload["status"])}, expected RED`);
        const inbox = await waitFor(
          "B's HEALTH_RED inbox item",
          async () => (await b.call<{ items: { kind: string }[] }>("inbox_list", {})).items,
          (items) => items.some((item) => item.kind === "HEALTH_RED"),
          STEP_MS,
        );
        await b.call("sandbox_write_file", {
          path: "refresh.js",
          content:
            'import { createAccessToken } from "./auth.js";\n\nexport function refreshHandler(userId) {\n  return { status: 200, token: createAccessToken(userId) };\n}\n',
        });
        const fixed = await b.call<{ status: string; applied_revision: number }>("submit_changes", {
          paths: ["refresh.js"],
          message: "Use the renamed helper",
          task_id: tasks[1]!.id,
        });
        if (fixed.status !== "APPLIED") throw new Error(`B's fix was ${fixed.status}`);
        const green = await waitFor(
          `the health run for revision ${fixed.applied_revision}`,
          () => healthOf(fixed.applied_revision),
          (event) => event !== undefined && event.payload["status"] !== "RUNNING",
          HEALTH_MS,
        );
        if (green?.payload["status"] !== "GREEN")
          throw new Error(`health was ${String(green?.payload["status"])}, expected GREEN`);
        return `RED at ${broken.applied_revision} (${inbox.length} inbox item(s)), GREEN at ${fixed.applied_revision}`;
      },
    );

    // 14. B's production deploy is denied by capability and recorded.
    await step(
      {
        id: "14",
        title: "B invokes aws.deploy_lambda on prod-api (MCP)",
        expectation: "denied, with capability.denied in the room events",
        budgetMs: STEP_MS,
      },
      async () => {
        let denial = "";
        try {
          await agent("AgentB").call("tools_invoke", {
            tool: "aws.deploy_lambda",
            args: {
              function: "prod-api",
              region: "us-east-1",
              s3_bucket: "project-alpha-artifacts",
              s3_key: "release.zip",
              s3_object_version: "v1",
              publish: false,
            },
          });
        } catch (error) {
          denial = errorText(error);
        }
        if (!denial) throw new Error("the deploy was not refused");
        const denied = await waitFor(
          "capability.denied in the room events",
          async () => (await roomEvents()).filter((event) => event.type === "capability.denied"),
          (list) => list.length > 0,
          STEP_MS / 2,
        );
        return `refused (${denial.slice(0, 80)}); ${denied.length} capability.denied event(s)`;
      },
    );

    // 15. Peter pauses C: its action is refused; resumed, the same action works.
    await step(
      {
        id: "15",
        title: "Peter pauses Agent C, C acts, Peter resumes",
        expectation: "C's action fails with PARTICIPANT_PAUSED, then succeeds after the resume",
        budgetMs: STEP_MS,
      },
      async () => {
        const act = () => agent("AgentC").call("presence_set_intent", { paths: ["routes.js"] });
        await owner.api.participants.pause({ participant_id: idOf("AgentC") });
        let refused = "";
        try {
          await act();
        } catch (error) {
          refused = errorText(error);
        }
        if (!refused.includes("PARTICIPANT_PAUSED"))
          throw new Error(`while paused C's action gave: ${refused || "success"}`);
        await owner.api.participants.resume({ participant_id: idOf("AgentC") });
        await act();
        return "PARTICIPANT_PAUSED while paused; accepted after the resume";
      },
    );

    // 16. A and B submit with evidence; the lead approves; health is still GREEN.
    await step(
      {
        id: "16",
        title: "A and B submit tasks with evidence; the lead approves (MCP)",
        expectation: "both tasks are DONE and the latest health run is GREEN",
        budgetMs: STEP_MS,
      },
      async () => {
        const evidence = [
          {
            requirement: 0,
            proof: [{ kind: "test", ref: "Project Alpha Docker health is GREEN" }],
          },
        ];
        const lead = agent("ArchitectAgent");
        const done: string[] = [];
        for (const [who, task] of [
          ["AgentA", tasks[0]!],
          ["AgentB", tasks[1]!],
        ] as const) {
          const submitted = await agent(who).call<TaskView>("tasks_submit", {
            task_id: task.id,
            expected_version: await versionOf(task),
            evidence,
          });
          const approved = await lead.call<TaskView>("tasks_review", {
            task_id: submitted.id,
            expected_version: submitted.version,
            verdict: "approve",
            comments: "The required work and green health evidence are present.",
          });
          if (approved.status !== "DONE") throw new Error(`${who}'s task is ${approved.status}`);
          done.push(approved.status);
        }
        const runs = (await roomEvents()).filter((event) => event.type === "workspace.health");
        const latest = runs.at(-1)?.payload["status"];
        if (latest !== "GREEN") throw new Error(`the latest health run is ${String(latest)}`);
        return `${done.length} tasks DONE; latest health GREEN`;
      },
    );
  } catch (error) {
    failure = error;
  } finally {
    stopGroup(vite);
    for (const agentSession of agents) await agentSession.close().catch(() => undefined);
    await summary(["step 17 (needs a real GitHub App)"]);
    await writeFile(join(OUT_DIR, "server.log"), await serverLogTail(100_000));
  }

  // The leak check runs whether or not a step failed; the CI job uploads the logs only if it passes.
  const checked = await assertNoLeaks([OUT_DIR]);
  process.stdout.write(`leak check  PASS  ${checked}\n`);
  await writeFile(join(OUT_DIR, "leak-check.ok"), `${checked}\n`);
  if (failure) throw failure;
});
