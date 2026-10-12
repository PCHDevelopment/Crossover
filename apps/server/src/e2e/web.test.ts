import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { CrossoverClient, type RoomClient } from "@crossover/sdk";
import { DEFAULT_PROTECTED_PATHS } from "@crossover/workspace/protected-paths";
import { git, type UpstreamFetcher } from "@crossover/workspace";
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
let upstreamDir: string;
let remoteRepo: string;

const gitIdentity = {
  GIT_AUTHOR_NAME: "Crossover E2E",
  GIT_AUTHOR_EMAIL: "e2e@example.com",
  GIT_COMMITTER_NAME: "Crossover E2E",
  GIT_COMMITTER_EMAIL: "e2e@example.com",
};
const runGit = (cwd: string, args: string[]) =>
  git(args, { cwd, timeoutMs: 30_000, env: gitIdentity });

const upstreamFetcher: UpstreamFetcher = {
  async fetch() {
    const cloneDir = await mkdtemp(join(tmpdir(), "crossover-web-upstream-"));
    const repo = join(cloneDir, "repo.git");
    await runGit(cloneDir, ["clone", "-q", "--bare", upstreamDir, repo]);
    const sha = (
      await git(["rev-parse", "HEAD"], { gitDir: repo, timeoutMs: 10_000 })
    ).stdout.trim();
    return {
      repo,
      ref: "HEAD",
      sha,
      cleanup: () => rm(cloneDir, { recursive: true, force: true }),
    };
  },
};

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
  upstreamDir = join(dir, "upstream");
  await mkdir(upstreamDir, { recursive: true });
  await runGit(upstreamDir, ["init", "-q", "-b", "main"]);
  await writeFile(join(upstreamDir, "README.md"), "# Browser acceptance fixture\n");
  await writeFile(
    join(upstreamDir, "package.json"),
    JSON.stringify({ name: "widgets", scripts: { typecheck: "tsc --noEmit", test: "vitest run" } }),
  );
  await runGit(upstreamDir, ["add", "README.md", "package.json"]);
  await runGit(upstreamDir, ["commit", "-q", "-m", "Initial"]);
  const remoteParent = join(dir, "remote");
  await mkdir(remoteParent);
  await runGit(remoteParent, ["init", "-q", "--bare", "-b", "main", "widgets.git"]);
  remoteRepo = join(remoteParent, "widgets.git");
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
  server = await composeServer(config, {
    pool: db.pool,
    upstream: {
      fetcher: upstreamFetcher,
      resolve: async () => ["93.184.216.34"],
      pusher: {
        async push(request) {
          await git(
            ["push", "--porcelain", remoteRepo, `${request.commit}:refs/heads/${request.branch}`],
            { gitDir: request.repo, timeoutMs: 30_000 },
          );
        },
      },
      pullRequests: {
        async create() {
          return { url: "https://github.com/acme/widgets/pull/42", number: 42 };
        },
      },
    },
  });
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
    const confirmationMessages: string[] = [];
    let acceptDialogs = true;
    page.on("dialog", (dialog) => {
      confirmationMessages.push(dialog.message());
      void (acceptDialogs ? dialog.accept() : dialog.dismiss());
    });
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

    // The same person, from code, has owner access; room setup itself stays in the browser.
    const client = new CrossoverClient({ baseUrl });
    const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
    const owner: RoomClient = client.room(
      roomId,
      (await client.roomSession(login.session_token, roomId)).tokens.access_token,
    );
    await page.getByTestId("tab-setup").click();
    await page.getByTestId("import-url").fill("https://github.com/acme/widgets");
    await page.getByTestId("import-submit").click();
    await expect
      .poll(async () => page.getByTestId("import-status").textContent())
      .toContain("Repository import synced at revision 1.");
    await expect
      .poll(async () => page.getByTestId("health-command-suggestion").textContent())
      .toContain("npm run typecheck && npm test");

    const readHealthSettings = async () =>
      (
        await owner.api.room.get_state<{
          sections: { room: { settings: Record<string, unknown> | null } };
        }>()
      ).response.sections.room.settings;
    await page.getByTestId("health-use-suggestion").click();
    await expect
      .poll(async () => (await readHealthSettings())?.health_command)
      .toBe("npm run typecheck && npm test");
    await page.getByTestId("health-command").fill("node --check package.json");
    await page.getByTestId("health-image").fill("");
    await page.getByTestId("health-save").click();
    await expect
      .poll(async () => (await readHealthSettings())?.health_command)
      .toBe("node --check package.json");
    await expect
      .poll(async () => (await readHealthSettings())?.health_image)
      .toBe("node:22-bookworm-slim");
    await expect.poll(() => page.getByTestId("health-clear").isEnabled()).toBe(true);
    await page.getByTestId("health-clear").click();
    await expect.poll(async () => (await readHealthSettings())?.health_command).toBe(null);

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByTestId("invite-create").click();
    await expect.poll(async () => page.getByTestId("invite-token").count()).toBe(1);
    const inviteToken = await page.getByTestId("invite-token").inputValue();
    expect(inviteToken).not.toBe("");
    await page.getByTestId("invite-join-examples").locator("summary").click();
    const joinExamples = await page.getByTestId("invite-join-examples").textContent();
    expect(joinExamples).toContain(`room join ${roomId} --invite-token-stdin`);
    expect(joinExamples).toContain("CROSSOVER_INVITE_TOKEN");
    expect(joinExamples).toContain("CROSSOVER_ROOM_ACCESS_TOKEN");
    expect(joinExamples).toContain("one hour");
    expect(joinExamples).toContain("stored room credentials");
    expect(joinExamples).not.toContain(inviteToken);
    await page.getByTestId("invite-copy").click();
    await expect.poll(async () => page.getByTestId("invite-copy").textContent()).toBe("Copied");
    expect(
      await page.evaluate(() =>
        (
          navigator as unknown as { clipboard: { readText: () => Promise<string> } }
        ).clipboard.readText(),
      ),
    ).toBe(inviteToken);
    await page.getByTestId("invite-hide").click();
    await expect.poll(async () => page.getByTestId("invite-token").count()).toBe(0);
    expect(await page.locator("body").innerText()).not.toContain(inviteToken);
    await page.getByTestId("tab-activity").click();
    await expect
      .poll(async () => page.getByTestId("feed").textContent())
      .toContain("participant.invited");
    expect(await page.getByTestId("feed").textContent()).not.toContain(inviteToken);
    await page.getByTestId("tab-setup").click();
    await expect.poll(async () => page.getByTestId("invite-token").count()).toBe(0);

    const joinAgent = async (
      name: string,
      token?: string,
      role: "DEVELOPER" | "OBSERVER" = "DEVELOPER",
    ) => {
      const invite = token ? undefined : await owner.api.room.invite<{ role: string }>({ role });
      const joined = await client.join(roomId, {
        token: token ?? (invite!.one_time as { token: string }).token,
        manifest: manifest(name),
      });
      return {
        id: (joined as unknown as { participant_id: string }).participant_id,
        room: client.room(roomId, joined.tokens.access_token),
      };
    };

    // 3. Three agents join; the page shows them as they arrive.
    const architect = await joinAgent("ArchitectAgent", inviteToken);
    const agentA = await joinAgent("AgentA");
    const agentB = await joinAgent("AgentB");
    const agentC = await joinAgent("AgentC");
    await page.getByTestId("tab-overview").click();
    await expect
      .poll(async () =>
        page
          .getByTestId("participant")
          .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-name"))),
      )
      .toEqual(expect.arrayContaining(["Peter", "ArchitectAgent", "AgentA", "AgentB", "AgentC"]));

    // 4. ArchitectAgent becomes lead.
    await page.getByTestId("tab-setup").click();
    await page.getByTestId("lead-participant").selectOption(architect.id);
    await page.getByTestId("appoint-lead").click();
    await page.getByTestId("tab-overview").click();
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

    // T1404: governance controls are owner-only and use existing room commands.
    const guestLogin = await client.devLogin({ subject: "RoomGuest", display_name: "RoomGuest" });
    const guestUser = await db.pool.query<{ id: string }>(
      "SELECT id FROM users WHERE provider = 'dev' AND provider_subject = $1",
      ["RoomGuest"],
    );
    const guestId = `part_web_guest_${process.pid}`;
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status, user_id, joined_at)
       VALUES ($1, $2, 'HUMAN', 'RoomGuest', 'MEMBER', 'OBSERVER', 'ACTIVE', $3, clock_timestamp())`,
      [guestId, roomId, guestUser.rows[0]!.id],
    );
    const guestRoom = client.room(
      roomId,
      (await client.roomSession(guestLogin.session_token, roomId)).tokens.access_token,
    );
    await expect(guestRoom.api.room.freeze({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    const guestPage = await browser!.newPage();
    await guestPage.goto(baseUrl);
    await guestPage.evaluate(
      (token) => sessionStorage.setItem("crossover.session", token),
      guestLogin.session_token,
    );
    await guestPage.goto(`${baseUrl}/rooms/${roomId}`);
    await guestPage.getByTestId("room-title").waitFor();
    await expect.poll(() => guestPage.getByTestId("tab-owner-controls").count()).toBe(0);

    const observer = await joinAgent("ObserverAgent", undefined, "OBSERVER");
    await page.getByTestId("tab-owner-controls").click();
    await page.getByTestId("owner-controls").waitFor();

    await page.getByTestId("egress-hosts").fill("registry.acme.test\n*.packages.example");
    await page.getByTestId("save-egress").click();
    await expect
      .poll(() => page.getByTestId("owner-controls-notice").textContent())
      .toContain("complete");
    await owner.api.room.set_egress_allowlist({ hosts: ["live.example"] });
    await expect.poll(() => page.getByTestId("egress-hosts").inputValue()).toBe("live.example");
    await page.getByTestId("protected-paths").fill("draft/protected/**");
    await owner.api.room.set_egress_allowlist({ hosts: ["live.example", "refresh.example"] });
    await expect
      .poll(() => page.getByTestId("egress-hosts").inputValue())
      .toBe("live.example\nrefresh.example");
    await expect
      .poll(() => page.getByTestId("protected-paths").inputValue())
      .toBe("draft/protected/**");
    await page.getByTestId("protected-paths").fill(DEFAULT_PROTECTED_PATHS.join("\n"));
    await page.getByTestId("egress-hosts").fill("draft.example");
    await owner.api.room.set_protected_paths({ patterns: ["external/**"] });
    await expect.poll(() => page.getByTestId("protected-paths").inputValue()).toBe("external/**");
    await expect.poll(() => page.getByTestId("egress-hosts").inputValue()).toBe("draft.example");
    await page.getByTestId("egress-hosts").fill("live.example\nrefresh.example");
    await page.getByTestId("protected-paths").fill("infra/release/**\n.github/workflows/**");
    await page.getByTestId("save-protected-paths").click();
    await expect
      .poll(() => page.getByTestId("owner-controls-notice").textContent())
      .toContain("complete");
    const settings = (
      await owner.api.room.get_state<{
        sections: { room: { settings: Record<string, unknown> } };
      }>({ view: "summary" })
    ).response.sections.room.settings;
    expect(settings["egress_allowlist"]).toEqual(["live.example", "refresh.example"]);
    expect(settings["protected_paths"]).toEqual([".github/workflows/**", "infra/release/**"]);

    await page.getByTestId("capability-participant").selectOption(observer.id);
    await page.getByTestId("capability-bundle").waitFor();
    await page.getByTestId("capability-input").fill("tasks.create");
    await page.getByTestId("capability-requires-approval").check();
    await page.getByTestId("grant-capability").click();
    await expect
      .poll(() => page.getByTestId("capability-grant").textContent())
      .toContain("tasks.create (tier 1, approval required)");
    await expect(
      observer.room.api.tasks.create({
        title: "Approval gated work",
        requirements: ["Review me"],
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(
      observer.room.api.tasks.create({
        title: "Rejected gated work",
        requirements: ["Reject me"],
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect.poll(() => page.getByTestId("pending-approval").count()).toBe(2);
    const approvalRow = page
      .getByTestId("pending-approval")
      .filter({ hasText: "Approval gated work" });
    await approvalRow.getByTestId("approve-request").click();
    await expect
      .poll(async () => {
        const result = await owner.api.tasks.list<{ tasks: { title: string }[] }>({ limit: 100 });
        return result.response.tasks.some((task) => task.title === "Approval gated work");
      })
      .toBe(true);
    await expect.poll(() => page.getByTestId("pending-approval").count()).toBe(1);
    const rejectedRow = page
      .getByTestId("pending-approval")
      .filter({ hasText: "Rejected gated work" });
    await rejectedRow.getByTestId("reject-request").click();
    await expect.poll(() => page.getByTestId("pending-approval").count()).toBe(0);
    await expect
      .poll(async () => {
        const result = await owner.api.tasks.list<{ tasks: { title: string }[] }>({ limit: 100 });
        return result.response.tasks.some((task) => task.title === "Rejected gated work");
      })
      .toBe(false);
    await page.getByTestId("revoke-capability").click();
    await expect.poll(() => page.getByTestId("capability-grant").count()).toBe(0);

    const observerRow = page.getByTestId("owner-participant").filter({ hasText: "ObserverAgent" });
    acceptDialogs = false;
    await observerRow.getByTestId("remove-participant").click();
    await expect.poll(() => observerRow.count()).toBe(1);
    acceptDialogs = true;
    await observerRow.getByTestId("remove-participant").click();
    await expect.poll(() => observerRow.count()).toBe(0);
    const removed = await db.pool.query<{ status: string }>(
      "SELECT status FROM participants WHERE id = $1",
      [observer.id],
    );
    expect(removed.rows[0]?.status).toBe("REMOVED");

    await page.getByTestId("freeze-room").click();
    await expect.poll(() => page.getByTestId("owner-room-status").textContent()).toBe("PAUSED");
    await page.getByTestId("resume-room").click();
    await expect.poll(() => page.getByTestId("owner-room-status").textContent()).toBe("ACTIVE");
    expect(confirmationMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Use this command for room health checks?"),
        "Save the room health settings?",
        "Clear the room health command?",
        expect.stringContaining("registry.acme.test, *.packages.example"),
        expect.stringContaining("infra/release/**, .github/workflows/**"),
        expect.stringContaining("Grant tasks.create to ObserverAgent with approval required"),
        expect.stringContaining("Approve tasks.create from ObserverAgent"),
        expect.stringContaining("Rejected gated work"),
        expect.stringContaining("Revoke tasks.create from ObserverAgent"),
        expect.stringContaining("ObserverAgent"),
        expect.stringContaining("Project Alpha"),
      ]),
    );
    await guestPage.close();

    expect(problems).toEqual([]);
    await page.getByTestId("sign-out").click();
    await page.getByTestId("login-name").waitFor();
  }, 120_000);

  it("shows task evidence and missing requirements so the lead can review the task", async () => {
    const page = await browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (entry) => {
      if (entry.type() === "error") problems.push(`console: ${entry.text()}`);
    });

    await page.goto(baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Task Review");
    await page.getByTestId("room-objective").fill("Review evidence and export a checkpoint");
    await page.getByTestId("room-create").click();
    await expect.poll(async () => page.getByTestId("room-title").textContent()).toBe("Task Review");
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl });
    const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
    const owner: RoomClient = client.room(
      roomId,
      (await client.roomSession(login.session_token, roomId)).tokens.access_token,
    );
    const ownerId = (await db.pool.query("SELECT owner_id FROM rooms WHERE id = $1", [roomId]))
      .rows[0].owner_id as string;
    await owner.api.git.import({ url: "https://github.com/acme/widgets", branch: "main" });
    const invite = await owner.api.room.invite<unknown>({ role: "DEVELOPER" });
    const joined = await client.join(roomId, {
      token: (invite.one_time as { token: string }).token,
      manifest: manifest("ReviewAgent"),
    });
    const agentId = (joined as unknown as { participant_id: string }).participant_id;
    const agent = client.room(roomId, joined.tokens.access_token);
    const task = (
      await owner.api.tasks.create<{ id: string; version: number }>({
        title: "Release note",
        description: "Provide evidence for the implemented work.",
        requirements: ["Unit tests pass", "Supply a release note"],
        reviewer_id: ownerId,
      })
    ).response;
    const assigned = (
      await owner.api.tasks.assign<{ version: number }>({
        task_id: task.id,
        expected_version: task.version,
        participant_id: agentId,
      })
    ).response;
    const started = (
      await agent.api.tasks.start<{ version: number }>({
        task_id: task.id,
        expected_version: assigned.version,
      })
    ).response;
    await agent.api.tasks.submit({
      task_id: task.id,
      expected_version: started.version,
      evidence: [{ requirement: 0, proof: [{ kind: "test", ref: "unit tests pass" }] }],
    });

    await page.getByTestId("tab-delivery").click();
    const reviewTask = page.getByTestId("review-task");
    await expect.poll(async () => reviewTask.textContent()).toContain("Release note");
    await expect
      .poll(async () => reviewTask.getByTestId("task-evidence").textContent())
      .toContain("unit tests pass");
    await expect
      .poll(async () => reviewTask.getByTestId("task-missing-evidence").textContent())
      .toContain("Missing evidence for: Supply a release note");
    await reviewTask.getByTestId("review-comments").fill("Evidence checked.");
    await reviewTask.getByTestId("approve-task").click();
    await expect.poll(async () => page.getByTestId("review-task").count()).toBe(0);
    await expect
      .poll(async () => {
        const page = await owner.api.tasks.list<{ tasks: { id: string; status: string }[] }>({
          status: ["DONE"],
          limit: 100,
        });
        return page.response.tasks.some((item) => item.id === task.id);
      })
      .toBe(true);

    await page.getByTestId("checkpoint-message").fill("T1405 reviewed");
    await page.getByTestId("create-checkpoint").click();
    await expect
      .poll(async () => page.getByTestId("checkpoint-list").textContent())
      .toContain("T1405 reviewed");
    await owner.api.capabilities.grant({
      participant_id: ownerId,
      capability: "github.create_pull_request:acme/widgets",
    });
    await page.getByTestId("export-open-pull-request").check();
    await page.getByTestId("pull-request-title").fill("T1405 acceptance");
    await page.getByTestId("export-checkpoint").click();
    await expect
      .poll(async () => page.getByTestId("export-pull-request-link").getAttribute("href"))
      .toBe("https://github.com/acme/widgets/pull/42");
    await expect
      .poll(async () => page.getByTestId("export-result").textContent())
      .toContain("Exported to");

    expect(problems).toEqual([]);
    await page.close();
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
    // Keep the file much longer than the diff editor viewport to exercise a nonzero scroll state.
    const tail = Array.from({ length: 240 }, (_, i) => `line-${String(i + 4).padStart(4, "0")}`);
    const originalContent = ["one", "two", "three", ...tail].join("\n");
    await api.workspace.apply_changeset({
      source: "API",
      message: "Seed",
      base_workspace_revision: 0,
      operations: [{ type: "create", path: "src/m.txt", content: originalContent }],
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
    await result.click();
    await page.keyboard.press("Control+End");
    await expect.poll(async () => result.textContent()).toContain(tail.at(-1));
    await page.getByTestId("take-theirs").click();
    await expect.poll(async () => result.textContent()).toContain(tail.at(-1));
    await page.getByTestId("take-both").click();
    await expect.poll(async () => result.textContent()).toContain(tail.at(-1));
    await page.getByTestId("merge-submit").click();
    await page.getByTestId("merge-view").waitFor({ state: "detached" });
    expect((await file()).content).toBe(
      ["one", "two-mine", "two-theirs", "three", ...tail].join("\n"),
    );
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
    expect((await file()).content).toBe(["one", "TWO", "two-theirs", "three", ...tail].join("\n"));
    await expect.poll(async () => lines.textContent()).toContain("TWO");
    expect(problems).toEqual([]);
  }, 120_000);

  it("T1403: the Changes tab shows diffs, lets the lead resolve an escalated conflict, and approve a held ChangeSet", async () => {
    const page: Page = await browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });
    await page.goto(baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Changes room");
    await page.getByTestId("room-objective").fill("Review ChangeSets");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl });
    const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
    const owner = client.room(
      roomId,
      (await client.roomSession(login.session_token, roomId)).tokens.access_token,
    );
    const invite = await owner.api.room.invite<unknown>({ role: "DEVELOPER" });
    const joined = await client.join(roomId, {
      token: (invite.one_time as { token: string }).token,
      manifest: manifest("ChangeAgent"),
    });
    const agent = client.room(roomId, joined.tokens.access_token);

    const clean = await owner.api.workspace.apply_changeset<{
      status: string;
      changeset_id: string;
      applied_revision: number;
    }>({
      source: "API",
      message: "Add clean file",
      base_workspace_revision: 0,
      operations: [{ type: "create", path: "docs/clean.txt", content: "clean diff line\n" }],
    });
    await page.getByTestId("tab-changes").click();
    const cleanRow = page.locator(
      `[data-testid="change"][data-id="${clean.response.changeset_id}"]`,
    );
    await expect.poll(() => cleanRow.getAttribute("data-status")).toBe("APPLIED");
    await cleanRow.getByRole("button", { name: "View diff" }).click();
    await expect
      .poll(async () => page.getByTestId("changes-diff").textContent())
      .toContain("clean diff line");

    const baseText = Array.from({ length: 4_000 }, (_, index) => `line ${index}`).join("\n") + "\n";
    const headText = baseText.replace("line 2000\n", "head line 2000\n");
    const mineText = baseText.replace("line 2000\n", "agent line 2000\n");
    await owner.api.workspace.apply_changeset({
      source: "API",
      message: "Seed conflict file",
      base_workspace_revision: clean.response.applied_revision,
      operations: [{ type: "create", path: "docs/conflict.txt", content: baseText }],
    });
    const base = await owner.api.workspace.read<{
      content: string;
      workspace_revision: number;
      file_revision: number;
    }>({ path: "docs/conflict.txt" });
    await owner.api.workspace.apply_changeset({
      source: "API",
      message: "Change the head",
      base_workspace_revision: base.response.workspace_revision,
      base_file_revisions: { "docs/conflict.txt": base.response.file_revision },
      operations: [{ type: "modify", path: "docs/conflict.txt", content: headText }],
    });
    const submitted = await agent.api.workspace.apply_changeset<{
      status: string;
      changeset_id: string;
      conflict_id: string;
    }>({
      source: "API",
      message: "Submit overlapping change",
      base_workspace_revision: base.response.workspace_revision,
      base_file_revisions: { "docs/conflict.txt": base.response.file_revision },
      operations: [{ type: "modify", path: "docs/conflict.txt", content: mineText }],
    });
    expect(submitted.response.status).toBe("CONFLICT");
    await agent.api.conflicts.escalate({ conflict_id: submitted.response.conflict_id });

    const conflictRow = page.locator(
      `[data-testid="conflict"][data-id="${submitted.response.conflict_id}"]`,
    );
    await expect.poll(() => conflictRow.getAttribute("data-status")).toBe("ESCALATED");
    await conflictRow.getByRole("button", { name: "Details" }).click();
    await page
      .getByRole("heading", { name: `Conflict ${submitted.response.conflict_id}` })
      .waitFor();
    await page.getByRole("button", { name: "Resolve in MergeView" }).click();
    await page.getByTestId("merge-view").waitFor();
    for (let repetition = 0; repetition < 20; repetition++) {
      // Choosing a side rewrites the modified model and starts another asynchronous diff. Leave
      // the tab immediately so the view and its models are disposed while that work is pending.
      await page.getByTestId("take-theirs").click();
      await page.getByTestId("take-ours").click();
      await page.getByTestId("take-both").click();
      await page.getByTestId("tab-activity").click();
      await expect.poll(() => page.getByTestId("merge-view").count()).toBe(0);
      await page.waitForTimeout(50);
      expect(problems.filter((problem) => problem.startsWith("pageerror:"))).toEqual([]);

      await page.getByTestId("tab-changes").click();
      await expect.poll(() => conflictRow.getAttribute("data-status")).toBe("ESCALATED");
      await conflictRow.getByRole("button", { name: "Details" }).click();
      await page.getByRole("button", { name: "Resolve in MergeView" }).click();
      await page.getByTestId("merge-view").waitFor();
    }
    await page.getByTestId("merge-submit").click();
    await page.getByTestId("merge-view").waitFor({ state: "detached" });
    await expect
      .poll(
        async () =>
          (
            await db.pool.query("SELECT status FROM conflicts WHERE id = $1", [
              submitted.response.conflict_id,
            ])
          ).rows[0]?.status,
      )
      .toBe("RESOLVED");
    expect(
      (await owner.api.workspace.read<{ content: string }>({ path: "docs/conflict.txt" })).response
        .content,
    ).toBe(mineText);

    const current = await owner.api.workspace.read<{ workspace_revision: number }>({
      path: "docs/clean.txt",
    });
    let holdError: unknown;
    try {
      await agent.api.workspace.apply_changeset({
        source: "API",
        message: "Create protected workflow",
        base_workspace_revision: current.response.workspace_revision,
        operations: [{ type: "create", path: ".github/workflows/ci.yml", content: "name: held\n" }],
      });
    } catch (error) {
      holdError = error;
    }
    expect(holdError).toMatchObject({ code: "CIRCUIT_BREAKER" });
    const heldId = String(
      (holdError as { details?: { changeset_id?: string } }).details?.changeset_id,
    );
    const heldRow = page.locator(`[data-testid="change"][data-id="${heldId}"]`);
    await expect.poll(() => heldRow.getAttribute("data-status")).toBe("HELD");
    await expect.poll(async () => heldRow.textContent()).toContain("protected_path");
    await heldRow.getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => heldRow.getAttribute("data-status")).toBe("APPLIED");
    expect(
      (
        await owner.api.workspace.read<{ content: string }>({
          path: ".github/workflows/ci.yml",
        })
      ).response.content,
    ).toBe("name: held\n");
    expect(problems).toEqual([]);
  }, 120_000);

  it("T1402 step 5: decide in the browser and read the memory mirror", async () => {
    const page: Page = await browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (entry) => {
      if (entry.type() === "error") problems.push(`console: ${entry.text()}`);
    });

    await page.goto(baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Decisions room");
    await page.getByTestId("room-objective").fill("Decisions and shared memory in the browser");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl });
    const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
    const session = await client.roomSession(login.session_token, roomId);
    const owner: RoomClient = client.room(roomId, session.tokens.access_token);
    await owner.api.room.set_lead({ participant_id: session.participant_id });
    const invite = await owner.api.room.invite<unknown>({ role: "DEVELOPER" });
    const joined = await client.join(roomId, {
      token: (invite.one_time as { token: string }).token,
      manifest: manifest("NonLeadDecisionAgent"),
    });
    const nonLead = client.room(roomId, joined.tokens.access_token);
    await page.reload();
    await page.getByTestId("room-title").waitFor();
    await page.getByTestId("tab-collaboration").click();
    await page.getByTestId("collab-decisions").click();

    // A live decision event refreshes the list without erasing the current form draft.
    await page.getByTestId("decision-title").fill("Draft while decisions change");
    await page.getByTestId("decision-options").fill("First\nSecond");
    await nonLead.api.decisions.propose({
      title: "Use short-lived sessions?",
      options: [{ summary: "Yes" }, { summary: "No" }],
    });
    await expect
      .poll(() => page.getByTestId("decision-title").inputValue())
      .toBe("Draft while decisions change");

    // §30 step 5: propose, take positions, decide, then read the system memory mirror.
    await page.getByTestId("decision-title").fill("Session tokens or JWT");
    await page.getByTestId("decision-context").fill("Choose the authentication format.");
    await page.getByTestId("decision-options").fill("Session tokens\nJWT");
    await page.getByTestId("decision-propose").click();
    await expect
      .poll(() => page.getByTestId("decision-detail").textContent())
      .toContain("Session tokens or JWT");
    const decisionId = (
      await owner.api.decisions.list<{ decisions: { id: string; title: string }[] }>({ limit: 100 })
    ).response.decisions.find((decision) => decision.title === "Session tokens or JWT")!.id;
    await expect(
      nonLead.api.decisions.decide({
        decision_id: decisionId,
        expected_version: 1,
        outcome_option_id: "opt_1",
        rationale: "Non-lead attempt",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await page.getByTestId("position-option").selectOption("opt_2");
    await page.getByTestId("position-argument").fill("JWT works across our current clients.");
    await page.getByTestId("add-position").click();
    await expect
      .poll(() => page.getByTestId("decision-detail").textContent())
      .toContain("JWT works across our current clients.");
    await page.getByTestId("decision-outcome").selectOption("opt_2");
    await page
      .getByTestId("decision-rationale")
      .fill("JWT is the best fit for the current clients.");
    await page.getByTestId("decide").click();
    await expect
      .poll(() => page.getByTestId("decision-detail").textContent())
      .toContain("ACCEPTED");
    await expect
      .poll(() => page.getByTestId("decision-detail").textContent())
      .toContain("JWT is the best fit");

    await page.getByTestId("collab-memory").click();
    const mirror = page.getByTestId("memory-key").filter({ hasText: `decisions/${decisionId}` });
    await expect.poll(() => mirror.count()).toBe(1);
    await mirror.click();
    await expect
      .poll(() => page.getByTestId("memory-detail").textContent())
      .toContain("Session tokens or JWT");
    await expect
      .poll(() => page.getByTestId("memory-detail").textContent())
      .toContain("JWT is the best fit");
    await expect.poll(() => page.getByTestId("memory-history").textContent()).toContain("system");

    expect(problems).toEqual([]);
    await page.close();
  }, 120_000);

  it("T1402 step 13: a failing health run appears in the author's inbox and can be acknowledged", async () => {
    const page: Page = await browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (entry) => {
      if (entry.type() === "error") problems.push(`console: ${entry.text()}`);
    });

    await page.goto(baseUrl);
    await page.getByTestId("login-name").fill("Health author");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Health inbox room");
    await page.getByTestId("room-objective").fill("Surface and acknowledge failing health runs");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl });
    const login = await client.devLogin({
      subject: "Health author",
      display_name: "Health author",
    });
    const session = await client.roomSession(login.session_token, roomId);
    const owner: RoomClient = client.room(roomId, session.tokens.access_token);
    await page.getByTestId("tab-collaboration").click();
    await page.getByTestId("collab-inbox").click();

    const imported = await owner.api.git.import<{ applied_revision: number }>({
      url: "https://github.com/acme/widgets",
      branch: "main",
    });
    await owner.api.room.set_health({ health_command: "node --check broken.js" });
    await owner.api.workspace.apply_changeset({
      source: "API",
      message: "Add a syntax error to trigger the health notice",
      base_workspace_revision: imported.response.applied_revision,
      operations: [{ type: "create", path: "broken.js", content: "module.exports = ;\n" }],
    });

    const revision = imported.response.applied_revision + 1;
    await expect
      .poll(
        async () => {
          const { rows } = await db.pool.query<{ status: string }>(
            "SELECT status FROM health_runs WHERE room_id = $1 AND revision = $2 ORDER BY created_at DESC LIMIT 1",
            [roomId, revision],
          );
          return rows[0]?.status ?? null;
        },
        { timeout: 90_000 },
      )
      .toBe("RED");
    await expect
      .poll(
        async () => {
          const inbox = await owner.api.inbox.list<{ items: { kind: string }[] }>({
            unacked_only: true,
          });
          return inbox.response.items.some((entry) => entry.kind === "HEALTH_RED");
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    const item = page.getByTestId("inbox-item");
    await expect.poll(() => item.count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => item.textContent()).toContain("HEALTH_RED");
    await expect.poll(() => item.textContent()).toContain("Health check failed");
    await page.getByTestId("inbox-ack").click();
    await expect
      .poll(() => page.getByTestId("inbox-list").textContent())
      .toContain("No unacknowledged inbox items.");
    await expect
      .poll(async () => {
        const inbox = await owner.api.inbox.list<{ items: unknown[] }>({ unacked_only: true });
        return inbox.response.items.length;
      })
      .toBe(0);

    expect(problems).toEqual([]);
    await page.close();
  }, 120_000);
});
