import { AsyncLocalStorage } from "node:async_hooks";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CrossoverClient, type RoomClient, type RoomTokens } from "@crossover/sdk";
import type { Page } from "playwright-core";
import { expect, it } from "vitest";
import { manifest, type WebFixture } from "./web-fixture.js";

const STEP_TIMEOUT_MS = 45_000;
const DOCKER_STEP_TIMEOUT_MS = 150_000;
const HEALTH_STEP_TIMEOUT_MS = 150_000;

interface DemoParticipant {
  id: string;
  room: RoomClient;
}

interface RoomEvent {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}

interface WorkspaceFile {
  content: string;
  file_revision: number;
  workspace_revision: number;
}

interface TaskView {
  id: string;
  title: string;
  version: number;
  status: string;
}

interface ToolCallResult {
  isError?: boolean;
  content?: { text?: string }[];
  structuredContent?: unknown;
}

type StepRunner = <T>(signal: AbortSignal, action: () => Promise<T>) => Promise<T>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trackSdkFetches() {
  const active = new Set<AbortSignal>();
  const stepSignal = new AsyncLocalStorage<AbortSignal>();
  const shutdown = new AbortController();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const signals = [init?.signal, stepSignal.getStore(), shutdown.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const signal = AbortSignal.any(signals);
    active.add(signal);
    try {
      return await globalThis.fetch(input, {
        ...(init ?? {}),
        signal,
      });
    } catch (error) {
      if (!signal.aborted) throw error;
      // SDK calls without a caller signal otherwise retry a canceled request as a transport error.
      return new Response(null, { status: 499, statusText: "Client closed request" });
    } finally {
      active.delete(signal);
    }
  };
  return {
    fetch,
    run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
      return stepSignal.run(signal, action);
    },
    abortPending(): number {
      const pending = active.size;
      shutdown.abort();
      return pending;
    },
  };
}

async function runDemoStep<T>(
  label: string,
  action: () => Promise<T>,
  timeoutMs = STEP_TIMEOUT_MS,
  runWithSignal?: StepRunner,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let actionSettled = false;
  const work = (runWithSignal ? runWithSignal(controller.signal, action) : action()).finally(() => {
    actionSettled = true;
  });
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    throw new Error(`${label}: ${errorText(error)}`, { cause: error });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (!actionSettled) controller.abort(new Error(`${label} ended before its action settled`));
  }
}

async function waitForStep<T>(
  label: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "no observation yet";
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (ready(value)) return value;
      last = JSON.stringify(value)?.slice(0, 280) ?? String(value);
    } catch (error) {
      last = errorText(error).slice(0, 280);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; last observation: ${last}`);
}

async function callMcp<T>(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as ToolCallResult;
  if (result.isError) {
    throw new Error(`MCP ${name} failed: ${result.content?.map((item) => item.text).join("\n")}`);
  }
  if (typeof result.structuredContent === "object" && result.structuredContent !== null)
    return result.structuredContent as T;
  throw new Error(`MCP ${name} returned no structured result`);
}

async function roomEvents(room: RoomClient): Promise<RoomEvent[]> {
  return (await room.api.room.events.list<{ events: RoomEvent[] }>({ limit: 500 })).response.events;
}

async function workspaceFile(room: RoomClient, path: string): Promise<WorkspaceFile> {
  return (await room.api.workspace.read<WorkspaceFile>({ path })).response;
}

async function runDockerProbe(participant: DemoParticipant, label: string): Promise<void> {
  const started = (
    await participant.room.api.sandbox.exec<{ exec_id: string }>({
      command: "node --version",
      timeout_s: 30,
    })
  ).response;
  const finished = await waitForStep(
    `${label}: Docker sandbox command finishes`,
    async () =>
      (await roomEvents(participant.room)).find(
        (event) =>
          event.type === "sandbox.exec.finished" && event.payload["exec_id"] === started.exec_id,
      ),
    (event): event is RoomEvent => event !== undefined,
    DOCKER_STEP_TIMEOUT_MS,
  );
  if (!finished) throw new Error(`${label}: sandbox completion event was not returned`);
  expect(finished.payload["exit_code"], `${label}: node --version should succeed`).toBe(0);
}

function registerWebDemoFlow(fixture: WebFixture): void {
  it("T1406: walks the complete Project Alpha demo through the browser, SDK, MCP, and Docker", async () => {
    const page: Page = await fixture.browser!.newPage();
    const sdkFetch = trackSdkFetches();
    const demoStep = <T>(label: string, action: () => Promise<T>, timeoutMs = STEP_TIMEOUT_MS) =>
      runDemoStep(label, action, timeoutMs, sdkFetch.run);
    page.setDefaultTimeout(STEP_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(STEP_TIMEOUT_MS);
    const problems: string[] = [];
    let mcp: McpClient | undefined;
    page.on("dialog", (dialog) => void dialog.accept());
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (entry) => {
      if (entry.type() === "error") problems.push(`console: ${entry.text()}`);
    });

    try {
      // 1. Peter creates Project Alpha in the real browser app.
      let roomId = "";
      await demoStep("step 1: Peter creates Project Alpha", async () => {
        await page.goto(fixture.baseUrl);
        await page.getByTestId("login-name").fill("Peter");
        await page.getByTestId("login-submit").click();
        await page.getByTestId("room-name").fill("Project Alpha");
        await page.getByTestId("room-objective").fill("Ship the login");
        await page.getByTestId("room-create").click();
        await waitForStep(
          "step 1: Project Alpha appears",
          () => page.getByTestId("room-title").textContent(),
          (title) => title === "Project Alpha",
        );
        roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;
      });

      const client = new CrossoverClient({ baseUrl: fixture.baseUrl, fetch: sdkFetch.fetch });
      const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
      const session = await client.roomSession(login.session_token, roomId);
      const owner = client.room(roomId, session.tokens);

      // 2. Peter imports the fixture repository in the browser and accepts its health suggestion.
      await demoStep(
        "step 2: Peter imports the repository and selects its health command",
        async () => {
          await page.getByTestId("tab-setup").click();
          await page.getByTestId("import-url").fill("https://github.com/acme/widgets");
          await page.getByTestId("import-submit").click();
          await waitForStep(
            "step 2: repository import completes",
            () => page.getByTestId("import-status").textContent(),
            (status) => status?.includes("Repository import synced at revision 1.") ?? false,
          );
          await waitForStep(
            "step 2: suggested health command is shown",
            () => page.getByTestId("health-command-suggestion").textContent(),
            (suggestion) => suggestion?.includes("npm run typecheck && npm test") ?? false,
          );
          await page.getByTestId("health-use-suggestion").click();
          await waitForStep(
            "step 2: health command is saved",
            async () =>
              (
                await owner.api.room.get_state<{
                  sections: { room: { settings: Record<string, unknown> | null } };
                }>()
              ).response.sections.room.settings?.["health_command"],
            (command) => command === "npm run typecheck && npm test",
          );
        },
      );

      // 3. Peter creates invites. ArchitectAgent joins over HTTP for real MCP; A/B/C use the SDK.
      const inviteTokens: string[] = [];
      await demoStep(
        "step 3: Peter creates four invites for the four named demo roles",
        async () => {
          await page.getByTestId("invite-create").click();
          for (let index = 0; index < 4; index++) {
            await waitForStep(
              `step 3: invite ${index + 1} is ready`,
              () => page.getByTestId("invite-token").count(),
              (count) => count === 1,
            );
            inviteTokens.push(await page.getByTestId("invite-token").inputValue());
            expect(inviteTokens.at(-1)).not.toBe("");
            await page.getByTestId("invite-hide").click();
            if (index < 3) await page.getByTestId("invite-create").click();
          }
        },
      );

      const joinWithSdk = async (name: string, token: string): Promise<DemoParticipant> => {
        const joined = await client.join(roomId, { token, manifest: manifest(name) });
        return {
          id: joined.participant_id as string,
          room: client.room(roomId, joined.tokens),
        };
      };
      let architect: DemoParticipant;
      let agentA: DemoParticipant;
      let agentB: DemoParticipant;
      let agentC: DemoParticipant;
      await demoStep("step 3: agents join through HTTP and the SDK", async () => {
        const response = await fetch(
          `${fixture.baseUrl}/v1/rooms/${encodeURIComponent(roomId)}/join`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: inviteTokens[0], manifest: manifest("ArchitectAgent") }),
          },
        );
        const body = (await response.json()) as {
          participant_id: string;
          tokens: RoomTokens;
        };
        if (!response.ok) throw new Error(`HTTP room join failed with ${response.status}`);
        architect = { id: body.participant_id, room: client.room(roomId, body.tokens) };
        agentA = await joinWithSdk("AgentA", inviteTokens[1]!);
        agentB = await joinWithSdk("AgentB", inviteTokens[2]!);
        agentC = await joinWithSdk("AgentC", inviteTokens[3]!);

        mcp = new McpClient({ name: "crossover-t1406-demo", version: "1.0.0" });
        await mcp.connect(
          new StreamableHTTPClientTransport(new URL(`${fixture.baseUrl}/mcp`), {
            requestInit: {
              headers: { Authorization: `Bearer ${body.tokens.access_token}` },
            },
          }) as never,
        );
        const tools = await mcp.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("decisions_propose");
      });

      // 4. Peter appoints the lead in the UI and changes his project role through the SDK.
      await demoStep("step 4: Peter appoints ArchitectAgent and takes Developer role", async () => {
        await page.getByTestId("tab-setup").click();
        await page.getByTestId("lead-participant").selectOption(architect.id);
        await page.getByTestId("appoint-lead").click();
        await page.getByTestId("tab-overview").click();
        await waitForStep(
          "step 4: ArchitectAgent is shown as lead",
          () => page.locator('[data-name="ArchitectAgent"]').textContent(),
          (text) => text?.includes("lead") ?? false,
        );
        await owner.api.participants.set_role({
          participant_id: session.participant_id,
          role: "DEVELOPER",
        });
      });

      // 5. The lead proposes and decides by MCP; the other agents add positions by SDK.
      let decisionId = "";
      await demoStep(
        "step 5: agents decide tokens versus JWT and Peter sees the memory mirror",
        async () => {
          await page.getByTestId("tab-collaboration").click();
          await page.getByTestId("collab-decisions").click();
          await callMcp(mcp!, "decisions_propose", {
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
          decisionId = listed.find((item) => item.title === "Session tokens or JWT")!.id;
          await agentA.room.api.decisions.add_position({
            decision_id: decisionId,
            option_id: "opt_1",
            argument: "Server-managed sessions are easy to revoke.",
          });
          await agentB.room.api.decisions.add_position({
            decision_id: decisionId,
            option_id: "opt_2",
            argument: "JWT supports stateless API consumers.",
          });
          const current = (
            await callMcp<{ version: number }>(mcp!, "decisions_get", { decision_id: decisionId })
          ).version;
          await callMcp(mcp!, "decisions_decide", {
            decision_id: decisionId,
            expected_version: current,
            outcome_option_id: "opt_1",
            rationale: "Revocation and the current server architecture favor sessions.",
          });
          await page.getByTestId("collab-memory").click();
          const mirror = page
            .getByTestId("memory-key")
            .filter({ hasText: `decisions/${decisionId}` });
          await waitForStep(
            "step 5: decision appears in the memory list",
            () => mirror.count(),
            (count) => count === 1,
          );
          await mirror.click();
          await waitForStep(
            "step 5: memory mirror shows the accepted decision",
            () => page.getByTestId("memory-detail").textContent(),
            (text) =>
              (text?.includes("Session tokens or JWT") && text.includes("ACCEPTED")) ?? false,
          );
        },
      );

      // 6. ArchitectAgent creates four reviewed tasks through MCP; A/B receive and claim work.
      let tasks: TaskView[] = [];
      let assignedA: TaskView;
      let assignedB: TaskView;
      let startedA: TaskView;
      let startedB: TaskView;
      await demoStep(
        "step 6: lead creates and assigns four tasks; A and B claim work",
        async () => {
          const titles = [
            "Session tokens",
            "API routes",
            "Conflict handling",
            "Health verification",
          ];
          tasks = [];
          for (const title of titles) {
            tasks.push(
              await callMcp<TaskView>(mcp!, "tasks_create", {
                title,
                requirements: ["Complete the Project Alpha walkthrough work."],
                reviewer_id: architect.id,
                review_required: true,
              }),
            );
          }
          assignedA = await callMcp<TaskView>(mcp!, "tasks_assign", {
            task_id: tasks[0]!.id,
            expected_version: tasks[0]!.version,
            participant_id: agentA.id,
          });
          assignedB = await callMcp<TaskView>(mcp!, "tasks_assign", {
            task_id: tasks[1]!.id,
            expected_version: tasks[1]!.version,
            participant_id: agentB.id,
          });
          await agentA.room.api.tasks.claim({
            task_id: tasks[2]!.id,
            expected_version: tasks[2]!.version,
          });
          await agentB.room.api.tasks.claim({
            task_id: tasks[3]!.id,
            expected_version: tasks[3]!.version,
          });
          startedA = (
            await agentA.room.api.tasks.start({
              task_id: tasks[0]!.id,
              expected_version: assignedA.version,
            })
          ).response as TaskView;
          startedB = (
            await agentB.room.api.tasks.start({
              task_id: tasks[1]!.id,
              expected_version: assignedB.version,
            })
          ).response as TaskView;
          await page.getByTestId("tab-tasks").click();
          await waitForStep(
            "step 6: all four tasks appear on the board",
            () => page.getByTestId("task").count(),
            (count) => count === 4,
          );
        },
      );

      // 7. Agent A publishes a lines 40-62 intent while Peter has the file open in Monaco.
      let initialAuth: WorkspaceFile;
      await demoStep("step 7: Agent A intent is visible over auth.js lines 40-62", async () => {
        await page.getByTestId("tab-files").click();
        await page.getByTestId("tree-dir").click();
        await page.locator('[data-path="src/auth.js"]').click();
        const editorLines = page.locator(".monaco-editor .view-lines");
        await waitForStep(
          "step 7: auth.js is loaded in the editor",
          () => editorLines.textContent(),
          (text) => text?.includes("createSessionToken") ?? false,
        );
        initialAuth = await workspaceFile(owner, "src/auth.js");
        await agentA.room.api.presence.update({
          open_files: ["src/auth.js"],
          cursor: { path: "src/auth.js", line: 40, column: 1 },
        });
        await agentA.room.api.presence.set_intent({
          paths: ["src/auth.js"],
          ranges: [{ path: "src/auth.js", start_line: 40, end_line: 62 }],
          task_id: tasks[0]!.id,
        });
        await waitForStep(
          "step 7: Agent A range is visible to Peter",
          () => page.getByTestId("edit-intent").textContent(),
          (text) =>
            text !== null && text.includes("AgentA") && text.includes("40") && text.includes("62"),
        );
      });

      // 8. Agent sandboxes are real Docker-backed working copies and hold private edits.
      await demoStep(
        "step 8: Agent A, B, and C use Docker sandboxes to prepare changes",
        async () => {
          await Promise.all([
            runDockerProbe(agentA, "step 8 Agent A"),
            runDockerProbe(agentB, "step 8 Agent B"),
            runDockerProbe(agentC, "step 8 Agent C"),
          ]);
          const agentAuth = initialAuth!.content.replace(
            "return `${tokenPrefix}${userId}`;",
            "return `${tokenPrefix}${userId}:agent-a`;",
          );
          expect(agentAuth).not.toBe(initialAuth!.content);
          await agentA.room.api.sandbox.file.write({ path: "src/auth.js", content: agentAuth });
          await agentB.room.api.sandbox.file.write({
            path: "src/api.js",
            content:
              'import * as auth from "./auth.js";\n\nexport function createLoginResponse(userId) {\n  return auth.createSessionToken(userId);\n}\n',
          });
        },
        DOCKER_STEP_TIMEOUT_MS,
      );

      // 9. Peter edits a disjoint identifier in the browser; the editor flushes the draft.
      await demoStep("step 9: Peter renames the helper and the browser draft flushes", async () => {
        const editorLines = page.locator(".monaco-editor .view-lines");
        await editorLines.click();
        await page.keyboard.press("Control+Home");
        for (let index = 0; index < "export function ".length; index++)
          await page.keyboard.press("ArrowRight");
        for (let index = 0; index < "createSessionToken".length; index++)
          await page.keyboard.press("Shift+ArrowRight");
        await page.keyboard.type("createAccessToken");
        await page.getByTestId("draft-indicator").waitFor({ state: "attached" });
        await waitForStep(
          "step 9: auth.js rename is saved by the editor",
          async () => (await workspaceFile(owner, "src/auth.js")).content,
          (content) =>
            content.includes("createAccessToken") && !content.includes("createSessionToken"),
          20_000,
        );
        await page.getByTestId("draft-indicator").waitFor({ state: "detached", timeout: 20_000 });
      });

      // 10. A syncs the disjoint Peter edit, then submits its sandbox change cleanly.
      await demoStep("step 10: Agent A syncs and submits a cleanly merged change", async () => {
        const current = await workspaceFile(owner, "src/auth.js");
        const syncResult = await agentA.room.api.sandbox.sync<{
          synced_to: number;
          conflicted_paths?: string[];
        }>({});
        const synced = syncResult.response;
        const afterSync = await agentA.room.api.sandbox.file.read<{ content: string }>({
          path: "src/auth.js",
        });
        expect(synced.synced_to).toBe(current.workspace_revision);
        expect(synced.conflicted_paths ?? []).toEqual([]);
        expect(afterSync.response.content).not.toContain("<<<<<<<");
        const submitted = (
          await agentA.room.api.changes.submit<{
            status: string;
            changeset_id: string;
            applied_revision: number;
          }>({ paths: ["src/auth.js"], message: "Update the session token", task_id: tasks[0]!.id })
        ).response;
        expect(submitted.status).toBe("APPLIED");
        await waitForStep(
          "step 10: merged auth.js contains both edits",
          async () => (await workspaceFile(owner, "src/auth.js")).content,
          (content) =>
            content.includes("createAccessToken") &&
            content.includes("${tokenPrefix}${userId}:agent-a"),
        );
      });

      // 11. Agent C submits from the original revision and conflicts with A's token edit.
      let conflictId = "";
      let afterAgentA: WorkspaceFile;
      await demoStep("step 11: Agent C creates an overlapping stale-base conflict", async () => {
        afterAgentA = await workspaceFile(owner, "src/auth.js");
        const conflictAuth = initialAuth!.content.replace(
          "return `${tokenPrefix}${userId}`;",
          "return `${tokenPrefix}${userId}:agent-c`;",
        );
        const submitted = (
          await agentC.room.api.workspace.apply_changeset<{
            status: string;
            conflict_id: string;
            counterparty_changesets: string[];
          }>({
            source: "API",
            message: "Agent C conflicts with the token update",
            base_workspace_revision: initialAuth!.workspace_revision,
            base_file_revisions: { "src/auth.js": initialAuth!.file_revision },
            operations: [{ type: "modify", path: "src/auth.js", content: conflictAuth }],
          })
        ).response;
        expect(submitted.status).toBe("CONFLICT");
        conflictId = submitted.conflict_id;
        expect(submitted.counterparty_changesets.length).toBeGreaterThan(0);
      });

      // 12. C syncs, fails two racing resolutions, and ArchitectAgent resolves in the browser.
      await demoStep(
        "step 12: Agent C syncs, two resolutions escalate, and the lead resolves in MergeView",
        async () => {
          const synced = (await agentC.room.api.sandbox.sync<{ synced_to: number }>({})).response;
          expect(synced.synced_to).toBeGreaterThan(afterAgentA!.workspace_revision - 1);

          const raceOneContent = afterAgentA!.content.replace(":agent-a`", ":agent-a:peter-one`");
          const raceOne = (
            await owner.api.workspace.apply_changeset<{
              status: string;
              applied_revision: number;
            }>({
              source: "API",
              message: "Peter updates the token while C resolves",
              base_workspace_revision: afterAgentA!.workspace_revision,
              base_file_revisions: { "src/auth.js": afterAgentA!.file_revision },
              operations: [{ type: "modify", path: "src/auth.js", content: raceOneContent }],
            })
          ).response;
          expect(raceOne.status).toBe("APPLIED");
          const failedOne = (
            await agentC.room.api.workspace.apply_changeset<{
              status: string;
              conflict_id: string;
            }>({
              source: "RESOLUTION",
              conflict_id: conflictId,
              message: "Agent C resolution attempt one",
              base_workspace_revision: afterAgentA!.workspace_revision,
              base_file_revisions: { "src/auth.js": afterAgentA!.file_revision },
              operations: [
                {
                  type: "modify",
                  path: "src/auth.js",
                  content: afterAgentA!.content.replace(":agent-a`", ":agent-c-resolution-one`"),
                },
              ],
            })
          ).response;
          expect(failedOne.status).toBe("CONFLICT");
          expect(failedOne.conflict_id).toBe(conflictId);

          const afterRaceOne = await workspaceFile(owner, "src/auth.js");
          const raceTwoContent = afterRaceOne.content.replace(
            ":agent-a:peter-one`",
            ":agent-a:peter-two`",
          );
          const raceTwo = (
            await owner.api.workspace.apply_changeset<{
              status: string;
              applied_revision: number;
            }>({
              source: "API",
              message: "Peter updates the token again while C resolves",
              base_workspace_revision: afterRaceOne.workspace_revision,
              base_file_revisions: { "src/auth.js": afterRaceOne.file_revision },
              operations: [{ type: "modify", path: "src/auth.js", content: raceTwoContent }],
            })
          ).response;
          expect(raceTwo.status).toBe("APPLIED");
          const failedTwo = (
            await agentC.room.api.workspace.apply_changeset<{
              status: string;
              conflict_id: string;
            }>({
              source: "RESOLUTION",
              conflict_id: conflictId,
              message: "Agent C resolution attempt two",
              base_workspace_revision: afterRaceOne.workspace_revision,
              base_file_revisions: { "src/auth.js": afterRaceOne.file_revision },
              operations: [
                {
                  type: "modify",
                  path: "src/auth.js",
                  content: afterRaceOne.content.replace(
                    ":agent-a:peter-one`",
                    ":agent-c-resolution-two`",
                  ),
                },
              ],
            })
          ).response;
          expect(failedTwo.status).toBe("CONFLICT");
          expect(failedTwo.conflict_id).toBe(conflictId);

          const leadInbox = (
            await architect.room.api.inbox.list<{
              items: { kind: string; ref: { kind: string; id: string } }[];
            }>({ unacked_only: true })
          ).response.items;
          expect(
            leadInbox.some((item) => item.kind === "ESCALATION" && item.ref.id === conflictId),
          ).toBe(true);

          await page.getByTestId("tab-changes").click();
          const conflictRow = page.locator(`[data-testid="conflict"][data-id="${conflictId}"]`);
          await waitForStep(
            "step 12: C's conflict reaches the lead as escalated",
            () => conflictRow.getAttribute("data-status"),
            (status) => status === "ESCALATED",
          );
          await conflictRow.getByRole("button", { name: "Details" }).click();
          await page.getByRole("heading", { name: `Conflict ${conflictId}` }).waitFor();
          await page.getByRole("button", { name: "Resolve in MergeView" }).click();
          await page.getByTestId("merge-view").waitFor();
          await page.getByTestId("take-theirs").click();
          await page.getByTestId("merge-submit").click();
          await page.getByTestId("merge-view").waitFor({ state: "detached" });
          const resolved = await architect.room.api.conflicts.get<{ status: string }>({
            conflict_id: conflictId,
          });
          expect(resolved.response.status).toBe("RESOLVED");
        },
        120_000,
      );

      // 13. B's stale API call turns health RED; B fixes it in the sandbox and health turns GREEN.
      let redRevision = 0;
      await demoStep(
        "step 13: real Docker health runner reports RED, then GREEN after Agent B's fix",
        async () => {
          const current = await workspaceFile(owner, "src/auth.js");
          const synced = (await agentB.room.api.sandbox.sync<{ synced_to: number }>({})).response;
          expect(synced.synced_to).toBe(current.workspace_revision);
          const broken = (
            await agentB.room.api.changes.submit<{
              status: string;
              applied_revision: number;
            }>({
              paths: ["src/api.js"],
              message: "Add the API route using the renamed token helper",
              task_id: tasks[1]!.id,
            })
          ).response;
          expect(broken.status).toBe("APPLIED");
          redRevision = broken.applied_revision;
          const redEvent = await waitForStep(
            "step 13: Docker health run for Agent B's revision reports RED",
            async () =>
              (await roomEvents(owner)).find(
                (event) =>
                  event.type === "workspace.health" && event.payload["revision"] === redRevision,
              ),
            (event) => event?.payload["status"] === "RED",
            HEALTH_STEP_TIMEOUT_MS,
          );
          if (!redEvent) throw new Error("step 13: RED health event was not returned");
          expect(redEvent.payload["status"]).toBe("RED");
          const inbox = await waitForStep(
            "step 13: Agent B receives the health inbox item",
            async () =>
              (
                await agentB.room.api.inbox.list<{ items: { kind: string }[] }>({
                  unacked_only: true,
                })
              ).response.items,
            (items) => items.some((item) => item.kind === "HEALTH_RED"),
            STEP_TIMEOUT_MS,
          );
          expect(inbox.some((item) => item.kind === "HEALTH_RED")).toBe(true);

          await agentB.room.api.sandbox.file.write({
            path: "src/api.js",
            content:
              'import * as auth from "./auth.js";\n\nexport function createLoginResponse(userId) {\n  return auth.createAccessToken(userId);\n}\n',
          });
          const fixed = (
            await agentB.room.api.changes.submit<{
              status: string;
              applied_revision: number;
            }>({
              paths: ["src/api.js"],
              message: "Use the renamed token helper",
              task_id: tasks[1]!.id,
            })
          ).response;
          expect(fixed.status).toBe("APPLIED");
          const greenEvent = await waitForStep(
            "step 13: Docker health run for Agent B's fix completes",
            async () =>
              (await roomEvents(owner)).find(
                (event) =>
                  event.type === "workspace.health" &&
                  event.payload["revision"] === fixed.applied_revision,
              ),
            (event) => ["GREEN", "RED", "ERROR"].includes(String(event?.payload["status"])),
            HEALTH_STEP_TIMEOUT_MS,
          );
          if (!greenEvent) throw new Error("step 13: GREEN health event was not returned");
          if (greenEvent.payload["status"] !== "GREEN") {
            const runId = greenEvent.payload["log_ref"];
            const details =
              typeof runId === "string"
                ? await owner.api.workspace.health.get<{
                    status: string;
                    summary?: string;
                    log_tail?: string;
                  }>({ run_id: runId })
                : undefined;
            throw new Error(
              `step 13: health was ${String(greenEvent.payload["status"])}: ${details?.response.log_tail ?? details?.response.summary ?? "no readable health log"}`,
            );
          }
          expect(greenEvent.payload["status"]).toBe("GREEN");
        },
        HEALTH_STEP_TIMEOUT_MS * 2 + 30_000,
      );

      // 14. B's scoped production deployment is denied and visible in Peter's Activity feed.
      await demoStep("step 14: production deploy denial appears in Activity", async () => {
        let denial: unknown;
        try {
          await agentB.room.api.tools.invoke({
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
          denial = error;
        }
        expect(denial).toMatchObject({ code: "FORBIDDEN" });
        await page.getByTestId("tab-activity").click();
        const denied = page.locator('[data-type="capability.denied"]');
        await waitForStep(
          "step 14: capability.denied is shown in Activity",
          () => denied.count(),
          (count) => count > 0,
        );
        expect(await denied.first().textContent()).toContain("AgentB");
      });

      // 15. Peter pauses and resumes Agent C in the browser.
      await demoStep("step 15: Peter pauses and resumes Agent C", async () => {
        await page.getByTestId("tab-overview").click();
        const row = page.locator('[data-name="AgentC"]');
        await row.getByTestId("pause").click();
        await waitForStep(
          "step 15: Agent C pauses",
          () => row.getByTestId("participant-status").textContent(),
          (status) => status === "PAUSED",
        );
        await row.getByTestId("resume").click();
        await waitForStep(
          "step 15: Agent C resumes",
          () => row.getByTestId("participant-status").textContent(),
          (status) => status === "ACTIVE",
        );
      });

      // 16. A/B submit their reviewed tasks after GREEN; ArchitectAgent approves through MCP.
      await demoStep("step 16: lead approves A and B tasks after health is GREEN", async () => {
        const evidence = [
          {
            requirement: 0,
            proof: [{ kind: "test" as const, ref: "Project Alpha Docker health is GREEN" }],
          },
        ];
        const submittedA = (
          await agentA.room.api.tasks.submit<TaskView>({
            task_id: tasks[0]!.id,
            expected_version: startedA!.version,
            evidence,
          })
        ).response;
        const submittedB = (
          await agentB.room.api.tasks.submit<TaskView>({
            task_id: tasks[1]!.id,
            expected_version: startedB!.version,
            evidence,
          })
        ).response;
        const approvedA = await callMcp<TaskView>(mcp!, "tasks_review", {
          task_id: submittedA.id,
          expected_version: submittedA.version,
          verdict: "approve",
          comments: "The required walkthrough and green health evidence are present.",
        });
        const approvedB = await callMcp<TaskView>(mcp!, "tasks_review", {
          task_id: submittedB.id,
          expected_version: submittedB.version,
          verdict: "approve",
          comments: "The required walkthrough and green health evidence are present.",
        });
        expect(approvedA.status).toBe("DONE");
        expect(approvedB.status).toBe("DONE");
      });

      // 17. ArchitectAgent checkpoints and exports through the SDK and fixture PR provider.
      await demoStep(
        "step 17: lead checkpoints the green head and opens a pull request",
        async () => {
          await owner.api.capabilities.grant({
            participant_id: architect.id,
            capability: "github.create_pull_request:acme/widgets",
          });
          const checkpoint = (
            await architect.room.api.checkpoints.create<{ id: string }>({
              message: "Project Alpha MVP demo flow complete",
            })
          ).response;
          const exported = (
            await architect.room.api.checkpoints.export<{
              pull_request: { url: string; number: number };
              branch: string;
            }>({
              checkpoint_id: checkpoint.id,
              pull_request: { title: "Project Alpha MVP demo" },
            })
          ).response;
          expect(exported.branch).toMatch(/^room\//);
          expect(exported.pull_request).toEqual({
            url: "https://github.com/acme/widgets/pull/42",
            number: 42,
          });
        },
        120_000,
      );

      expect(problems).toEqual([]);
    } finally {
      const canceledSdkRequests = sdkFetch.abortPending();
      if (canceledSdkRequests > 0)
        console.warn(`[web-e2e] canceled ${canceledSdkRequests} in-flight SDK request(s)`);
      await mcp?.close().catch(() => undefined);
      await page.close();
    }
  }, 600_000);
}

export { registerWebDemoFlow };
