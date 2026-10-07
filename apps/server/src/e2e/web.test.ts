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
});
