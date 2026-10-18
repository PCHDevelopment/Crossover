import { execFile, spawn } from "node:child_process";
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
// steps of section 3. Step 17 needs a real GitHub App and is out of scope.
const DEMO_REPO_URL =
  process.env["DEMO_REPO_URL"] ?? "https://github.com/PCHDevelopment/crossover-demo";
const FIXTURE = fileURLToPath(new URL("./demo-repo", import.meta.url));
const ROOM_BIN = process.env["ROOM_BIN"] ?? "room";
const UI_URL = "http://localhost:5173";
// Measured (T1570): idle runner, 3 green runs, per step 12 to 1,526 ms (step 0b the slowest, it starts
// Vite); budget = max x 7 rounded up to the next 5,000 ms, minimum 15,000 (the T1529 rule), so 15 s.
const STEP_MS = 15_000;

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

const manifestFor = (name: string) => ({
  name,
  operator: { name: "Peter", contact: "peter@example.com" },
  vendor: "Anthropic",
  model: "claude",
  client: "mcp",
  client_version: "1",
  description: `${name} in the compose rehearsal`,
});

it("rehearses docs/DEMO-RUNBOOK.md steps 1-7 against the real docker compose stack", async () => {
  await mkdir(OUT_DIR, { recursive: true });
  if (process.env["GIT_INTERNAL_TOKEN_SECRET"])
    secret("GIT_INTERNAL_TOKEN_SECRET", process.env["GIT_INTERNAL_TOKEN_SECRET"]);
  const agents: AgentMcp[] = [];
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
        const vite = spawn("pnpm", ["--filter", "@crossover/web", "dev"], {
          cwd: REPO_ROOT,
          stdio: "ignore",
          detached: true,
        });
        try {
          await waitFor(
            "the Vite dev server",
            async () => (await fetch(`${UI_URL}/`)).status,
            (status) => status === 200,
            // Vite is up in about 1.4 s (3 runs): 7x is 10 s, which leaves the rest of the step's 15 s for
            // the two proxy checks, and this wait reports what it last saw before the step's budget does.
            10_000,
          );
          const providers = async (base: string) => {
            const response = await fetch(`${base}/v1/auth/providers`);
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
          if (vite.pid) {
            try {
              process.kill(-vite.pid, "SIGTERM");
            } catch {
              // already gone
            }
          }
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
  } catch (error) {
    failure = error;
  } finally {
    for (const agentSession of agents) await agentSession.close().catch(() => undefined);
    // 17 needs a real GitHub App; 8-16 are the second half of T1570.
    await summary(["steps 8-16 (T1570 part B)", "step 17 (needs a real GitHub App)"]);
    await writeFile(join(OUT_DIR, "server.log"), await serverLogTail(100_000));
  }

  // The leak check runs whether or not a step failed; the CI job uploads the logs only if it passes.
  const checked = await assertNoLeaks([OUT_DIR]);
  process.stdout.write(`leak check  PASS  ${checked}\n`);
  await writeFile(join(OUT_DIR, "leak-check.ok"), `${checked}\n`);
  if (failure) throw failure;
});
