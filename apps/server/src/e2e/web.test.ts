import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { CrossoverClient, type RoomClient } from "@crossover/sdk";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

/**
 * The web app (T1104) in a real browser against a real server: login, create a room, see agents
 * join, the board, the Activity feed live (a denial among it), pause and resume. §30 steps 1, 3–4,
 * 6, 14 and 15: the people do what they do in the UI; the agents act through the SDK.
 */

const execFileAsync = promisify(execFile);
const root = new URL("../../../../", import.meta.url).pathname;

let db: TestDatabase;
let dir: string;
let server: CrossoverServer;
let baseUrl: string;
let browser: Browser | undefined;

/** A Chromium to drive: Playwright's own install, or the one the environment provides. */
function chromiumPath(): string | undefined {
  const candidates = [
    process.env["CHROMIUM_PATH"],
    chromium.executablePath(),
    process.env["PLAYWRIGHT_BROWSERS_PATH"] &&
      `${process.env["PLAYWRIGHT_BROWSERS_PATH"]}/chromium`,
  ];
  return candidates.find((p): p is string => !!p && existsSync(p));
}
const executablePath = chromiumPath();
/** In CI the browser test is the acceptance test: a missing browser fails it instead of skipping it. */
const inCi = Boolean(process.env["CI"]);

beforeAll(async () => {
  if (!executablePath) {
    if (inCi)
      throw new Error("No Chromium found in CI (install it: playwright-core install chromium)");
    return;
  }
  db = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), "crossover-web-e2e-"));
  const webRoot = join(dir, "web");
  await execFileAsync(
    "pnpm",
    ["--filter", "@crossover/web", "exec", "vite", "build", "--outDir", webRoot],
    {
      cwd: root,
      timeout: 120_000,
    },
  );
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: join(dir, "workspaces"),
    host: "127.0.0.1",
    port: 0,
    nodeId: `web-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
    webRoot,
  };
  server = await composeServer(config, { pool: db.pool });
  baseUrl = await server.app.listen({ port: 0, host: "127.0.0.1" });
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await db?.drop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const manifest = (name: string) => ({
  name,
  operator: { name: "Peter", contact: "peter@example.com" },
  vendor: "Anthropic",
  model: "m",
  client: "sdk-ts",
  client_version: "1",
  description: `${name} works here`,
});

describe.skipIf(!executablePath && !inCi)("web app in a browser", () => {
  it("login, create a room, agents join and a lead is appointed, tasks appear on the board, a denial shows in Activity, pause and resume work", async () => {
    const page: Page = await browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });

    // 1. Peter signs in and creates Project Alpha.
    await page.goto(baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Project Alpha");
    await page.getByTestId("room-objective").fill("Ship the login");
    await page.getByTestId("room-create").click();
    await expect
      .poll(async () => page.getByTestId("room-title").textContent())
      .toBe("Project Alpha");
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;
    // A reload keeps the session, and the room is on the list.
    await page.reload();
    await page.getByTestId("room-title").waitFor();
    await page.getByText("← Rooms").click();
    await expect
      .poll(async () => page.getByTestId("open-room").allTextContents())
      .toEqual(["Project Alpha"]);
    await page.getByTestId("open-room").click();
    await page.getByTestId("room-title").waitFor();

    // The same person, from code: owner access, to invite the agents (the invites are the people's part).
    const client = new CrossoverClient({ baseUrl });
    const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
    const owner: RoomClient = client.room(
      roomId,
      (await client.roomSession(login.session_token, roomId)).tokens.access_token,
    );
    const joinAgent = async (name: string) => {
      const invite = await owner.api.room.invite<unknown>({ role: "DEVELOPER" });
      const joined = await client.join(roomId, {
        token: (invite.one_time as { token: string }).token,
        manifest: manifest(name),
      });
      return {
        id: (joined as unknown as { participant_id: string }).participant_id,
        room: client.room(roomId, joined.tokens.access_token),
      };
    };

    // 3. Three agents join; the page shows them as they arrive.
    const architect = await joinAgent("ArchitectAgent");
    const agentA = await joinAgent("AgentA");
    const agentB = await joinAgent("AgentB");
    const agentC = await joinAgent("AgentC");
    await expect
      .poll(async () =>
        page
          .getByTestId("participant")
          .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-name"))),
      )
      .toEqual(expect.arrayContaining(["Peter", "ArchitectAgent", "AgentA", "AgentB", "AgentC"]));

    // 4. ArchitectAgent becomes lead.
    await owner.api.room.set_lead({ participant_id: architect.id });
    await expect
      .poll(async () => page.locator('[data-name="ArchitectAgent"]').textContent())
      .toContain("lead");

    // 6. The lead creates tasks and assigns them; two agents claim theirs. The board follows.
    const created: { id: string; version: number }[] = [];
    for (const title of ["Session tokens", "API routes", "Docs", "Rate limits"]) {
      const res = await architect.room.api.tasks.create<{ id: string; version: number }>({
        title,
        requirements: [`${title} done`],
      });
      created.push(res.response);
    }
    await architect.room.api.tasks.assign({
      task_id: created[0]!.id,
      expected_version: created[0]!.version,
      participant_id: agentA.id,
    });
    await agentB.room.api.tasks.claim({
      task_id: created[1]!.id,
      expected_version: created[1]!.version,
    });
    await page.getByTestId("tab-tasks").click();
    await expect.poll(async () => page.getByTestId("task").count()).toBe(4);
    await expect
      .poll(async () => page.getByTestId("column-OPEN").getByTestId("task").count())
      .toBe(2);
    expect(await page.getByTestId("board").textContent()).toContain("Session tokens");

    // 14. AgentB tries something it may not do; Peter sees the denial, live.
    await expect(
      agentB.room.api.events.redact({ sequence: 1, reason: "tidy" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await page.getByTestId("tab-activity").click();
    await expect
      .poll(async () => page.locator('[data-type="capability.denied"]').count())
      .toBeGreaterThan(0);
    expect(await page.locator('[data-type="capability.denied"]').first().textContent()).toContain(
      "AgentB",
    );
    await owner.api.messages.send({ body: "hello from Peter" });
    await expect
      .poll(async () => page.getByTestId("feed").textContent())
      .toContain("Peter sent a message");

    // 15. Peter pauses AgentC from the page, then resumes it.
    await page.getByTestId("tab-overview").click();
    const row = page.locator('[data-name="AgentC"]');
    await row.getByTestId("pause").click();
    await expect
      .poll(async () => row.getByTestId("participant-status").textContent())
      .toBe("PAUSED");
    const paused = await db.pool.query("SELECT status FROM participants WHERE id = $1", [
      agentC.id,
    ]);
    expect(paused.rows[0].status).toBe("PAUSED");
    await row.getByTestId("resume").click();
    await expect
      .poll(async () => row.getByTestId("participant-status").textContent())
      .toBe("ACTIVE");

    expect(problems).toEqual([]);
    await page.getByTestId("sign-out").click();
    await page.getByTestId("login-name").waitFor();
  }, 120_000);

  it("the editor (T1105a): open a file from the tree, edits flush as EDITOR ChangeSets on idle and on Ctrl+S, and someone else's change replaces a clean buffer", async () => {
    const page: Page = await browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });
    await page.goto(baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Editor room");
    await page.getByTestId("room-objective").fill("Edit files");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    // An agent (here: Peter from code) puts a file in the workspace.
    const client = new CrossoverClient({ baseUrl });
    const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
    const api = client.room(
      roomId,
      (await client.roomSession(login.session_token, roomId)).tokens.access_token,
    ).api;
    await api.workspace.apply_changeset({
      source: "API",
      message: "Seed",
      base_workspace_revision: 0,
      operations: [{ type: "create", path: "src/notes.txt", content: "one\ntwo\nthree\n" }],
    });
    const onServer = async () =>
      (await api.workspace.read<{ content: string }>({ path: "src/notes.txt" })).response.content;

    // Open it from the tree.
    await page.getByTestId("tab-files").click();
    await page.getByTestId("tree-dir").click();
    await page.locator('[data-path="src/notes.txt"]').click();
    const lines = page.locator(".monaco-editor .view-lines");
    await expect.poll(async () => lines.textContent()).toContain("three");
    expect(await page.getByTestId("editor-path").textContent()).toContain("src/notes.txt");

    // Typing makes a draft; 1.5 s without typing flushes it as an EDITOR ChangeSet.
    await lines.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("four");
    await page.getByTestId("draft-indicator").waitFor();
    await expect.poll(onServer, { timeout: 10_000 }).toBe("one\ntwo\nthree\nfour");
    await page.getByTestId("draft-indicator").waitFor({ state: "detached" });
    const sources = await db.pool.query(
      "SELECT source FROM changesets WHERE room_id = $1 AND status = 'APPLIED' ORDER BY created_at",
      [roomId],
    );
    expect(sources.rows.map((r) => r.source)).toEqual(["API", "EDITOR"]);

    // Ctrl+S flushes at once, even while another flush is in flight (held here for a second): keep
    // typing with no 1.5 s pause (and well within 10 s), and the text from before the second save
    // reaches the server while the latest keystroke has not.
    let held = false;
    await page.route("**/v1/rooms/*/commands", async (route) => {
      if (!held && route.request().postData()?.includes("workspace.apply_changeset")) {
        held = true;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      await route.continue();
    });
    await page.keyboard.type("A");
    await page.keyboard.press("Control+s");
    await expect.poll(() => held).toBe(true);
    await page.keyboard.type("B");
    await page.keyboard.press("Control+s");
    const typed: string[] = [];
    let saved = "";
    for (const key of ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"]) {
      await page.waitForTimeout(400);
      await page.keyboard.type(key);
      typed.push(key);
      saved = await onServer();
      if (saved.includes("fourAB")) break;
    }
    expect(saved).toContain("fourAB");
    expect(saved).not.toContain(typed.at(-1));
    await page.unroute("**/v1/rooms/*/commands");
    const final = `one\ntwo\nthree\nfourAB${typed.join("")}`;
    await expect.poll(onServer, { timeout: 10_000 }).toBe(final);
    await page.getByTestId("draft-indicator").waitFor({ state: "detached" });

    // Someone else changes the file: the clean buffer follows.
    const current = await api.workspace.read<{ workspace_revision: number; file_revision: number }>(
      { path: "src/notes.txt" },
    );
    await api.workspace.apply_changeset({
      source: "API",
      message: "Shout",
      base_workspace_revision: current.response.workspace_revision,
      base_file_revisions: { "src/notes.txt": current.response.file_revision },
      operations: [{ type: "modify", path: "src/notes.txt", content: final.replace("one", "ONE") }],
    });
    await expect.poll(async () => lines.textContent()).toContain("ONE");
    expect(await page.getByTestId("draft-indicator").count()).toBe(0);
    expect(await onServer()).toBe(final.replace("one", "ONE"));

    // A new file shows up in the folder that is already open in the tree.
    await api.workspace.apply_changeset({
      source: "API",
      message: "Add",
      base_workspace_revision: current.response.workspace_revision + 1,
      operations: [{ type: "create", path: "src/new.txt", content: "new\n" }],
    });
    await page.locator('[data-path="src/new.txt"]').waitFor();

    // A refused flush is reported once and not retried until the next edit or save.
    let attempts = 0;
    await page.route("**/v1/rooms/*/commands", async (route) => {
      if (!route.request().postData()?.includes("workspace.apply_changeset"))
        return route.continue();
      attempts++;
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Not allowed here" } }),
      });
    });
    await lines.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("Z");
    await page.getByTestId("files-notice").waitFor();
    await page.waitForTimeout(3_000);
    expect(attempts).toBe(1);
    expect(await page.getByTestId("draft-indicator").count()).toBe(1);
    await page.unroute("**/v1/rooms/*/commands");
    await page.keyboard.press("Control+s");
    await expect.poll(onServer, { timeout: 10_000 }).toContain("Z");

    // The browser logs the refused request itself; nothing else may have gone wrong.
    expect(problems.filter((p) => !p.includes("status of 403"))).toEqual([]);
  }, 120_000);

  it("presence and edit intents (T1105b): live cursors and ranges show in the editor", async () => {
    const page: Page = await browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });
    await page.goto(baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Presence room");
    await page.getByTestId("room-objective").fill("See each other");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl });
    const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
    const owner = client.room(
      roomId,
      (await client.roomSession(login.session_token, roomId)).tokens.access_token,
    );
    await owner.api.workspace.apply_changeset({
      source: "API",
      message: "Seed",
      base_workspace_revision: 0,
      operations: [{ type: "create", path: "src/notes.txt", content: "one\ntwo\nthree\n" }],
    });
    const invite = await owner.api.room.invite<unknown>({ role: "DEVELOPER" });
    const joined = await client.join(roomId, {
      token: (invite.one_time as { token: string }).token,
      manifest: manifest("Pair"),
    });
    const pair = client.room(roomId, joined.tokens.access_token);
    const pairId = (joined as unknown as { participant_id: string }).participant_id;

    await page.getByTestId("tab-files").click();
    await page.getByTestId("tree-dir").click();
    await page.locator('[data-path="src/notes.txt"]').click();
    const lines = page.locator(".monaco-editor .view-lines");
    await expect.poll(async () => lines.textContent()).toContain("three");

    // Pair opens the same file and selects part of line 2.
    await pair.api.presence.update({
      open_files: ["src/notes.txt"],
      cursor: {
        path: "src/notes.txt",
        line: 2,
        column: 3,
        selection: { start_line: 2, start_column: 1, end_line: 2, end_column: 3 },
      },
    });
    await page.locator(".remote-caret").waitFor();
    await page.locator(".remote-selection").first().waitFor();
    expect(
      await page
        .locator('[data-path="src/notes.txt"] [data-testid="file-viewer"]')
        .getAttribute("title"),
    ).toBe("Pair has this open");

    const task = await owner.api.tasks.create<{ id: string }>({
      title: "Update notes",
      requirements: ["Review the second paragraph"],
    });
    await pair.api.presence.set_intent({
      paths: ["src/notes.txt"],
      ranges: [{ path: "src/notes.txt", start_line: 2, end_line: 3 }],
      task_id: task.response.id,
    });
    await expect
      .poll(async () => page.getByTestId("edit-intent").textContent())
      .toContain("Pair · Update notes");
    await page.locator(".remote-intent").first().waitFor();

    await pair.api.presence.set_intent({ paths: ["src/notes.txt"], task_id: task.response.id });
    await expect
      .poll(async () => page.getByTestId("edit-intent").textContent())
      .toContain("whole file");
    await expect.poll(() => page.locator(".remote-intent").count()).toBe(0);

    // Peter puts the cursor on line 3: Pair sees it in presence.
    await lines.click();
    await page.keyboard.press("Control+End");
    const peter = async () =>
      (
        await pair.api.presence.list<{
          presence: { participant_id: string; cursor: { path: string; line: number } | null }[];
        }>()
      ).response.presence.find((p) => p.participant_id !== pairId);
    await expect
      .poll(async () => (await peter())?.cursor)
      .toMatchObject({ path: "src/notes.txt", line: 4 });

    // Clearing the ephemeral intent updates the existing presence subscription.
    await pair.api.presence.clear_intent({});
    await expect.poll(() => page.getByTestId("edit-intents").count()).toBe(0);
    await expect.poll(() => page.locator(".remote-intent").count()).toBe(0);

    // Pair closes the file: the caret and the tree marker go.
    await pair.api.presence.update({ open_files: [] });
    await page.locator(".remote-caret").waitFor({ state: "detached" });
    await page.locator('[data-testid="file-viewer"]').waitFor({ state: "detached" });

    // Leaving the Files tab tells the room no files are open here.
    await page.getByTestId("tab-overview").click();
    await expect.poll(async () => (await peter())?.cursor ?? null).toBeNull();
    expect(problems).toEqual([]);
  }, 120_000);

  it("the editor never overwrites someone else's change: a save after an overlapping change comes back as a Conflict", async () => {
    const page: Page = await browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });
    await page.goto(baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Overlap room");
    await page.getByTestId("room-objective").fill("Keep both");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;
    const client = new CrossoverClient({ baseUrl });
    const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
    const api = client.room(
      roomId,
      (await client.roomSession(login.session_token, roomId)).tokens.access_token,
    ).api;
    await api.workspace.apply_changeset({
      source: "API",
      message: "Seed",
      base_workspace_revision: 0,
      operations: [{ type: "create", path: "src/o.txt", content: "one\ntwo\nthree" }],
    });
    await page.getByTestId("tab-files").click();
    await page.getByTestId("tree-dir").click();
    await page.locator('[data-path="src/o.txt"]').click();
    const lines = page.locator('[data-testid="editor"] .view-lines');
    await expect.poll(async () => lines.textContent()).toContain("three");

    // Peter edits line 2; before his draft flushes, someone else rewrites the same line.
    await lines.click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.type("-mine");
    await api.workspace.apply_changeset({
      source: "API",
      message: "Theirs",
      base_workspace_revision: 1,
      base_file_revisions: { "src/o.txt": 1 },
      operations: [{ type: "modify", path: "src/o.txt", content: "one\ntwo-theirs\nthree" }],
    });
    await page.getByTestId("conflict-banner").waitFor();
    await page.keyboard.press("Control+s");
    await expect
      .poll(async () =>
        (
          await db.pool.query(
            "SELECT source, status FROM changesets WHERE room_id = $1 ORDER BY created_at",
            [roomId],
          )
        ).rows.map((r) => `${r.source} ${r.status}`),
      )
      .toEqual(["API APPLIED", "API APPLIED", "EDITOR CONFLICT"]);
    const now = await api.workspace.read<{ content: string }>({ path: "src/o.txt" });
    expect(now.response.content).toBe("one\ntwo-theirs\nthree");
    // Peter's edit isn't lost: the Conflict opens the merge view with it (T1105c).
    await page.getByTestId("merge-view").waitFor();
    await expect
      .poll(async () =>
        page
          .locator('[data-testid="merge-editor"] .modified .view-lines[role="presentation"]')
          .textContent(),
      )
      .toContain("two-mine");
    expect(problems).toEqual([]);
  }, 120_000);

  it("the merge view (T1105c): a flush that conflicts opens it; a resolution is applied and closes the conflict; discarding abandons it", async () => {
    const page: Page = await browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });
    await page.goto(baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Merge room");
    await page.getByTestId("room-objective").fill("Resolve conflicts");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;
    const client = new CrossoverClient({ baseUrl });
    const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
    const api = client.room(
      roomId,
      (await client.roomSession(login.session_token, roomId)).tokens.access_token,
    ).api;
    await api.workspace.apply_changeset({
      source: "API",
      message: "Seed",
      base_workspace_revision: 0,
      operations: [{ type: "create", path: "src/m.txt", content: "one\ntwo\nthree" }],
    });
    const file = async () =>
      (
        await api.workspace.read<{
          content: string;
          workspace_revision: number;
          file_revision: number;
        }>({ path: "src/m.txt" })
      ).response;
    const changeLineTwo = async (to: string) => {
      const now = await file();
      await api.workspace.apply_changeset({
        source: "API",
        message: "Theirs",
        base_workspace_revision: now.workspace_revision,
        base_file_revisions: { "src/m.txt": now.file_revision },
        operations: [
          {
            type: "modify",
            path: "src/m.txt",
            content: now.content
              .split("\n")
              .map((l, i) => (i === 1 ? to : l))
              .join("\n"),
          },
        ],
      });
    };
    const conflictStatuses = async () =>
      (
        await db.pool.query("SELECT status FROM conflicts WHERE room_id = $1 ORDER BY created_at", [
          roomId,
        ])
      ).rows.map((r) => r.status);

    await page.getByTestId("tab-files").click();
    await page.getByTestId("tree-dir").click();
    await page.locator('[data-path="src/m.txt"]').click();
    const lines = page.locator('[data-testid="editor"] .view-lines');
    await expect.poll(async () => lines.textContent()).toContain("three");

    // Peter rewrites line 2 while someone else does too: the edits can't be merged in, the
    // banner says so, and saving sends the flush that comes back as a Conflict.
    const editLineTwo = async (text: string) => {
      await lines.click();
      await page.keyboard.press("Control+Home");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("End");
      await page.keyboard.type(text);
    };
    await editLineTwo("-mine");
    await changeLineTwo("two-theirs");
    await page.getByTestId("conflict-banner").waitFor();
    await page.keyboard.press("Control+s");
    await page.getByTestId("merge-view").waitFor();
    expect(await page.getByTestId("merge-conflict").count()).toBe(1);
    const result = page.locator(
      '[data-testid="merge-editor"] .modified .view-lines[role="presentation"]',
    );
    await expect.poll(async () => result.textContent()).toContain("two-mine");
    await page.getByTestId("take-both").click();
    await expect.poll(async () => result.textContent()).toContain("two-theirs");
    await page.getByTestId("merge-submit").click();
    await page.getByTestId("merge-view").waitFor({ state: "detached" });
    expect((await file()).content).toBe("one\ntwo-mine\ntwo-theirs\nthree");
    expect(await conflictStatuses()).toEqual(["RESOLVED"]);
    await expect.poll(async () => lines.textContent()).toContain("two-theirs");
    expect(await page.getByTestId("draft-indicator").count()).toBe(0);

    // Again, and this time Peter discards his edits: the conflict is abandoned, the head stays.
    await editLineTwo("!");
    await changeLineTwo("TWO");
    await page.getByTestId("conflict-banner").waitFor();
    await page.keyboard.press("Control+s");
    await page.getByTestId("merge-view").waitFor();
    await page.getByTestId("merge-discard").click();
    await page.getByTestId("merge-view").waitFor({ state: "detached" });
    expect(await conflictStatuses()).toEqual(["RESOLVED", "ABANDONED"]);
    expect((await file()).content).toBe("one\nTWO\ntwo-theirs\nthree");
    await expect.poll(async () => lines.textContent()).toContain("TWO");
    expect(problems).toEqual([]);
  }, 120_000);
});
