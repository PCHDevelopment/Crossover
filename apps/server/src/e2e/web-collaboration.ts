import { DEFAULT_PROTECTED_PATHS } from "@crossover/protocol";
import { CrossoverClient, type RoomClient } from "@crossover/sdk";
import { manifest, type WebFixture } from "./web-fixture.js";
import { refuseNextCommand } from "./web-refusal.js";
import type { Page, Route } from "playwright-core";
import { expect, it } from "vitest";

/**
 * Hold the response of every budget status read the page makes, until it is released: the server
 * answers at once, and the page is handed the answer on `release()`. Each read records the message
 * limit it saw for `agentId`, so a test can tell the read that saw a change from the ones that did not.
 */
async function holdBudgetReads(page: Page, agentId: string) {
  type Read = {
    answered: boolean;
    sawLimit: number | undefined;
    release: () => void;
    delivered: Promise<void>;
  };
  const reads: Read[] = [];
  let holding = true;
  await page.route("**/v1/rooms/*/commands", async (route: Route) => {
    const request = route.request();
    const isRead =
      request.method() === "POST" && /"method"\s*:\s*"budgets\.get"/.test(request.postData() ?? "");
    if (!holding || !isRead) return route.continue();
    let release!: () => void;
    let delivered!: () => void;
    const read: Read = {
      answered: false,
      sawLimit: undefined,
      release: () => release(),
      delivered: new Promise<void>((resolve) => (delivered = resolve)),
    };
    const released = new Promise<void>((resolve) => (release = resolve));
    reads.push(read);
    const response = await route.fetch();
    const status = (await response.json()) as {
      response?: { agents?: { participant_id: string; effective?: { messages?: number } }[] };
    };
    read.sawLimit = status.response?.agents?.find((agent) => agent.participant_id === agentId)
      ?.effective?.messages;
    read.answered = true;
    await released;
    await route.fulfill({ response });
    delivered();
  });
  return {
    reads,
    /**
     * The newest read, by the order the page started them: the last one, once every read started so
     * far has been answered (and the page has had a moment to start any it was about to).
     */
    newest: async () => {
      await expect.poll(() => reads.length > 0 && reads.every((read) => read.answered)).toBe(true);
      await new Promise((done) => setTimeout(done, 250));
      await expect.poll(() => reads.every((read) => read.answered)).toBe(true);
      return reads[reads.length - 1]!;
    },
    /** The first read that saw this limit. */
    readSeeing: async (limit: number) => {
      await expect.poll(() => reads.some((read) => read.sawLimit === limit)).toBe(true);
      return reads.find((read) => read.sawLimit === limit)!;
    },
    /** Release every read still held, deliver them, and stop holding. */
    finish: async () => {
      holding = false;
      for (const read of reads) read.release();
      await Promise.all(reads.map((read) => read.delivered));
      await page.unroute("**/v1/rooms/*/commands");
    },
  };
}

/**
 * Hold the response of every command the page sends that `match` accepts: the server handles it at
 * once, and the page receives the response when `release()` is called. `answered` resolves when the
 * server has answered, `delivered` when the page has been handed the response. Requests that don't
 * match fall through to other route handlers.
 */
async function holdCommands(
  page: Page,
  match: (method: string, params: Record<string, unknown>) => boolean,
) {
  type Held = {
    method: string;
    answered: boolean;
    release: () => void;
    /** Hand the page a server error instead of the held response. */
    fail: () => void;
    delivered: Promise<void>;
  };
  const held: Held[] = [];
  let holding = true;
  const handler = async (route: Route) => {
    const request = route.request();
    let envelope: { method?: string; params?: Record<string, unknown> } = {};
    try {
      envelope = JSON.parse(request.postData() ?? "{}");
    } catch {
      // not a command
    }
    if (
      !holding ||
      request.method() !== "POST" ||
      !envelope.method ||
      !match(envelope.method, envelope.params ?? {})
    )
      return route.fallback();
    let release!: (fail: boolean) => void;
    let delivered!: () => void;
    const entry: Held = {
      method: envelope.method,
      answered: false,
      release: () => release(false),
      fail: () => release(true),
      delivered: new Promise<void>((resolve) => (delivered = resolve)),
    };
    const released = new Promise<boolean>((resolve) => (release = resolve));
    held.push(entry);
    const response = await route.fetch();
    entry.answered = true;
    const failed = await released;
    if (failed)
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INTERNAL", message: "The server failed" } }),
      });
    else await route.fulfill({ response });
    delivered();
  };
  await page.route("**/v1/rooms/*/commands", handler);
  return {
    held,
    /** The held commands with this method, once at least one has been answered by the server. */
    answered: async (method: string) => {
      await expect.poll(() => held.some((h) => h.method === method && h.answered)).toBe(true);
      // Give the page a moment to start any further matching reads it was about to make.
      await new Promise((done) => setTimeout(done, 250));
      return held.filter((h) => h.method === method);
    },
    /** Release everything still held, deliver it, and stop holding. */
    finish: async () => {
      holding = false;
      for (const h of held) h.release();
      await Promise.all(held.map((h) => h.delivered));
      await page.unroute("**/v1/rooms/*/commands", handler);
    },
  };
}

/** Let the page apply what it has just been handed. */
const settle = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => setTimeout(done, 250)));

export function registerWebCollaborationStart(fixture: WebFixture): void {
  it("T1507: the room header reports workspace status read refusals", async () => {
    const page: Page = await fixture.browser!.newPage();
    const finishRefusal = await refuseNextCommand(page, "workspace.history");
    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("Header owner");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Header status room");
    await page.getByTestId("room-objective").fill("Show status errors");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    await expect
      .poll(() => page.getByTestId("workspace-status-error").textContent())
      .toContain("The server refused this action");
    await finishRefusal();
    await page.reload();
    await page.getByTestId("room-title").waitFor();
    await expect.poll(() => page.getByTestId("workspace-status-error").count()).toBe(0);
    await page.close();
  }, 60_000);

  it("login, create a room, agents join and a lead is appointed, tasks appear on the board, a denial shows in Activity, pause and resume work", async () => {
    const page: Page = await fixture.browser!.newPage();
    const problems: string[] = [];
    const confirmationMessages: string[] = [];
    let acceptDialogs = true;
    page.on("dialog", (dialog) => {
      confirmationMessages.push(dialog.message());
      void (acceptDialogs ? dialog.accept() : dialog.dismiss());
    });
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().includes("status of 403"))
        problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });

    // 1. Peter signs in and creates Project Alpha.
    await page.goto(fixture.baseUrl);
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
    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
    const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
    const owner: RoomClient = client.room(
      roomId,
      (await client.roomSession(login.session_token, roomId)).tokens.access_token,
    );
    const hasExpectedFields = (actual: unknown, expected: unknown): boolean => {
      if (Array.isArray(expected)) {
        return (
          Array.isArray(actual) &&
          actual.length === expected.length &&
          expected.every((entry, index) => hasExpectedFields(actual[index], entry))
        );
      }
      if (typeof expected === "object" && expected !== null) {
        if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return false;
        return Object.entries(expected).every(([key, value]) =>
          hasExpectedFields((actual as Record<string, unknown>)[key], value),
        );
      }
      return Object.is(actual, expected);
    };
    const waitForOwnerCommand = (method: string, params: Record<string, unknown>) =>
      page.waitForResponse((response) => {
        const request = response.request();
        if (
          request.method() !== "POST" ||
          new URL(response.url()).pathname !== `/v1/rooms/${roomId}/commands`
        )
          return false;
        try {
          const body = request.postDataJSON() as { method?: string; params?: unknown } | null;
          return body?.method === method && hasExpectedFields(body.params, params);
        } catch {
          return false;
        }
      });
    await page.getByTestId("tab-setup").click();
    await page.getByTestId("import-url").fill("https://github.com/acme/widgets");
    await page.getByTestId("import-submit").click();
    await expect
      .poll(async () => page.getByTestId("import-status").textContent())
      .toContain("Repository import synced at revision 1.");
    const finishPullRefusal = await refuseNextCommand(page, "git.pull_upstream");
    await page.getByTestId("upstream-pull").click();
    await expect
      .poll(() => page.getByTestId("upstream-pull-error").textContent())
      .toContain("The server refused this action");
    await finishPullRefusal();
    await page.getByTestId("upstream-pull").click();
    await expect
      .poll(async () => page.getByTestId("upstream-pull-status").textContent())
      .toContain("already up to date");
    await expect
      .poll(async () => page.getByTestId("workspace-revision").textContent())
      .toContain("1");
    await expect
      .poll(async () => page.getByTestId("health-command-suggestion").textContent())
      .toContain("npm run typecheck && npm test");

    const readHealthSettings = async () =>
      (
        await owner.api.room.get_state<{
          sections: { room: { settings: Record<string, unknown> | null } };
        }>()
      ).response.sections.room.settings;
    const healthCommandUrl = `**/v1/rooms/${roomId}/commands`;
    let markHealthRefreshFetched!: () => void;
    let markHealthRefreshCompleted!: () => void;
    let releaseHealthRefresh!: () => void;
    const healthRefreshFetched = new Promise<void>((resolve) => {
      markHealthRefreshFetched = resolve;
    });
    const healthRefreshCompleted = new Promise<void>((resolve) => {
      markHealthRefreshCompleted = resolve;
    });
    const healthRefreshReleased = new Promise<void>((resolve) => {
      releaseHealthRefresh = resolve;
    });
    let healthRefreshHeld = false;
    const holdHealthRefresh = async (route: Route) => {
      let method: unknown;
      try {
        method = (route.request().postDataJSON() as { method?: unknown }).method;
      } catch {
        // Let malformed or unrelated requests continue to the real server.
      }
      if (method !== "room.get_state") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as {
        response?: { sections?: { room?: { settings?: Record<string, unknown> | null } } };
      };
      if (
        body.response?.sections?.room?.settings?.health_command === "npm run typecheck && npm test"
      ) {
        if (!healthRefreshHeld) {
          healthRefreshHeld = true;
          markHealthRefreshFetched();
        }
        await healthRefreshReleased;
        await route.fulfill({ response, body: JSON.stringify(body) });
        markHealthRefreshCompleted();
        return;
      }
      await route.fulfill({ response, body: JSON.stringify(body) });
    };
    await page.route(healthCommandUrl, holdHealthRefresh);
    const healthSuggestionResponse = waitForOwnerCommand("room.set_health", {
      health_command: "npm run typecheck && npm test",
    });
    await page.getByTestId("health-use-suggestion").click();
    expect((await healthSuggestionResponse).status()).toBe(200);
    await expect
      .poll(() => page.getByTestId("health-settings-status").textContent())
      .toBe("Health command configured.");
    await expect
      .poll(async () => (await readHealthSettings())?.health_command)
      .toBe("npm run typecheck && npm test");
    try {
      await expect.poll(() => healthRefreshHeld).toBe(true);
      await healthRefreshFetched;
      await page.getByTestId("health-command").fill("node --check package.json");
      await page.getByTestId("health-image").fill("node:22-bookworm-slim");
      await page.getByTestId("health-image").fill("");
    } finally {
      releaseHealthRefresh();
      if (healthRefreshHeld) await healthRefreshCompleted;
      await page.unroute(healthCommandUrl, holdHealthRefresh);
    }
    await expect
      .poll(() => page.getByTestId("health-command").inputValue())
      .toBe("node --check package.json");
    await expect.poll(() => page.getByTestId("health-image").inputValue()).toBe("");
    await expect.poll(() => page.getByTestId("health-save").isEnabled()).toBe(true);
    const healthSaveResponse = waitForOwnerCommand("room.set_health", {
      health_command: "node --check package.json",
      health_image: null,
    });
    await page.getByTestId("health-save").click();
    expect((await healthSaveResponse).status()).toBe(200);
    await expect
      .poll(async () => (await readHealthSettings())?.health_command)
      .toBe("node --check package.json");
    await expect
      .poll(async () => (await readHealthSettings())?.health_image)
      .toBe("node:22-bookworm-slim");
    await expect.poll(() => page.getByTestId("health-clear").isEnabled()).toBe(true);
    const healthClearResponse = waitForOwnerCommand("room.set_health", { health_command: null });
    await page.getByTestId("health-clear").click();
    expect((await healthClearResponse).status()).toBe(200);
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

    await page.getByTestId("task-title").fill("Browser-created task");
    await page.getByTestId("task-requirements").fill("Visible from the room board");
    await page.getByTestId("task-create").click();
    const browserTask = page.getByTestId("task").filter({ hasText: "Browser-created task" });
    await expect.poll(async () => browserTask.count()).toBe(1);
    await browserTask.getByTestId("task-assignee").selectOption(agentA.id);
    await browserTask.getByTestId("task-assign").click();
    await expect.poll(async () => browserTask.textContent()).toContain("AgentA");
    const claimable = page.getByTestId("task").filter({ hasText: "Docs" });
    const finishClaimRefusal = await refuseNextCommand(page, "tasks.claim");
    await claimable.getByTestId("task-claim").click();
    await expect
      .poll(() => page.getByTestId("notice").textContent())
      .toContain("The server refused this action");
    await finishClaimRefusal();
    await expect.poll(() => claimable.getByTestId("task-claim").isEnabled()).toBe(true);
    await claimable.getByTestId("task-claim").click();
    await expect.poll(async () => claimable.textContent()).toContain("Peter");

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
    const paused = await fixture.db.pool.query("SELECT status FROM participants WHERE id = $1", [
      agentC.id,
    ]);
    expect(paused.rows[0].status).toBe("PAUSED");
    await row.getByTestId("resume").click();
    await expect
      .poll(async () => row.getByTestId("participant-status").textContent())
      .toBe("ACTIVE");

    // T1404: governance controls are owner-only and use existing room commands.
    const guestLogin = await client.devLogin({ subject: "RoomGuest", display_name: "RoomGuest" });
    const guestUser = await fixture.db.pool.query<{ id: string }>(
      "SELECT id FROM users WHERE provider = 'dev' AND provider_subject = $1",
      ["RoomGuest"],
    );
    const guestId = `part_web_guest_${process.pid}`;
    await fixture.db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status, user_id, joined_at)
       VALUES ($1, $2, 'HUMAN', 'RoomGuest', 'MEMBER', 'OBSERVER', 'ACTIVE', $3, clock_timestamp())`,
      [guestId, roomId, guestUser.rows[0]!.id],
    );
    const guestRoom = client.room(
      roomId,
      (await client.roomSession(guestLogin.session_token, roomId)).tokens.access_token,
    );
    await expect(guestRoom.api.room.freeze({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(guestRoom.api.budgets.get({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(guestRoom.api.budgets.set({ budgets: { messages: 1 } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const guestPage = await fixture.browser!.newPage();
    await guestPage.goto(fixture.baseUrl);
    await guestPage.getByTestId("login-name").fill("RoomGuest");
    await guestPage.getByTestId("login-submit").click();
    // Signed in (the form for the next step exists): navigating earlier can cancel the login request
    // before its session cookie is stored (T1556).
    await guestPage.getByTestId("room-name").waitFor();
    await guestPage.goto(`${fixture.baseUrl}/rooms/${roomId}`);
    await guestPage.getByTestId("room-title").waitFor();
    await expect.poll(() => guestPage.getByTestId("tab-owner-controls").count()).toBe(0);

    const observer = await joinAgent("ObserverAgent", undefined, "OBSERVER");
    await page.getByTestId("tab-owner-controls").click();
    await page.getByTestId("owner-controls").waitFor();
    await expect
      .poll(() => page.getByTestId("refresh-budgets").textContent())
      .toBe("Refresh budget status");

    const commandUrl = `**/v1/rooms/${roomId}/commands`;
    let markInitialBudgetFetched!: () => void;
    let markInitialBudgetCompleted!: () => void;
    let releaseInitialBudget!: () => void;
    const initialBudgetFetched = new Promise<void>((resolve) => {
      markInitialBudgetFetched = resolve;
    });
    const initialBudgetCompleted = new Promise<void>((resolve) => {
      markInitialBudgetCompleted = resolve;
    });
    const initialBudgetReleased = new Promise<void>((resolve) => {
      releaseInitialBudget = resolve;
    });
    let initialBudgetHeld = false;
    const holdInitialBudgetLoad = async (route: Route) => {
      let method: unknown;
      try {
        method = (route.request().postDataJSON() as { method?: unknown }).method;
      } catch {
        // Let malformed or non-command requests continue to the real server.
      }
      if (initialBudgetHeld || method !== "budgets.get") {
        await route.continue();
        return;
      }
      initialBudgetHeld = true;
      const response = await route.fetch();
      markInitialBudgetFetched();
      await initialBudgetReleased;
      await route.fulfill({ response });
      markInitialBudgetCompleted();
    };
    await page.route(commandUrl, holdInitialBudgetLoad);
    const initialBudgetLoad = waitForOwnerCommand("budgets.get", {});
    await page.getByTestId("refresh-budgets").click();
    try {
      await expect.poll(() => initialBudgetHeld).toBe(true);
      await initialBudgetFetched;
      await expect
        .poll(() => page.getByTestId("refresh-budgets").textContent())
        .toBe("Loading budgets…");
      await page.getByTestId("room-budget-messages").fill("8");
    } finally {
      releaseInitialBudget();
      if (initialBudgetHeld) await initialBudgetCompleted;
      await page.unroute(commandUrl, holdInitialBudgetLoad);
    }
    expect((await initialBudgetLoad).status()).toBe(200);
    await expect
      .poll(() => page.getByTestId("refresh-budgets").textContent())
      .toBe("Refresh budget status");
    await expect.poll(() => page.getByTestId("room-budget-messages").inputValue()).toBe("8");

    // The notice below can still show the previous action's "... complete." right after a click,
    // so each save is awaited by polling the state it writes, then the notice is checked.
    interface BudgetState {
      room_budgets: Record<string, number | null>;
      compute_budgets: Record<string, number | null>;
      room_compute: { limit_vcpu_hours_per_day: number | null };
      agents: {
        participant_id: string;
        budgets: Record<string, number | null>;
        compute_budgets: Record<string, number | null>;
      }[];
    }
    const budgetState = async () => (await owner.api.budgets.get<BudgetState>({})).response;

    const roomBudgetSaveResponse = waitForOwnerCommand("budgets.set", {
      budgets: { messages: 8 },
    });
    await page.getByTestId("save-room-budgets").click();
    expect((await roomBudgetSaveResponse).status()).toBe(200);
    await expect.poll(async () => (await budgetState()).room_budgets).toEqual({ messages: 8 });
    await expect
      .poll(() => page.getByTestId("owner-controls-notice").textContent())
      .toContain("complete");

    await page.getByTestId("compute-budget-agent_vcpu_hours_per_day").fill("3");
    await page.getByTestId("compute-budget-room_vcpu_hours_per_day").fill("12");
    await page.getByTestId("save-compute-budgets").click();
    await expect
      .poll(async () => (await budgetState()).compute_budgets)
      .toEqual({
        agent_vcpu_hours_per_day: 3,
        room_vcpu_hours_per_day: 12,
      });
    await expect
      .poll(() => page.getByTestId("owner-controls-notice").textContent())
      .toContain("complete");
    expect((await budgetState()).room_compute.limit_vcpu_hours_per_day).toBe(12);

    await page.getByTestId("budget-agent").selectOption(agentA.id);
    await page.getByTestId("agent-budget-messages").fill("2");
    await page.getByTestId("agent-compute-budget-agent_vcpu_hours_per_day").fill("2");
    await page.getByTestId("save-agent-budgets").click();
    await expect
      .poll(async () =>
        (await budgetState()).agents.find((agent) => agent.participant_id === agentA.id),
      )
      .toMatchObject({
        budgets: { messages: 2 },
        compute_budgets: { agent_vcpu_hours_per_day: 2 },
      });
    await expect
      .poll(() => page.getByTestId("owner-controls-notice").textContent())
      .toContain("complete");
    await agentA.room.api.messages.send({ body: "budget usage check" });
    await page.getByTestId("refresh-budgets").click();
    await expect
      .poll(() => page.getByTestId(`budget-usage-${agentA.id}-messages`).textContent())
      .toContain("Messages: 1 used of 2 per minute");

    // T1556: reads of the budget status can finish out of order. A read that was answered before a
    // change but reaches the page after a newer one must not overwrite it, and the refresh button
    // must stay disabled until the newest read is in. A room-level change makes the page read again
    // (room.budgets_changed); ObserverAgent has no override, so its limit follows the room's. The
    // page can make other reads of its own at any time, so the newest read is the one that saw the
    // change.
    const shownLimit = () => page.getByTestId(`budget-usage-${observer.id}-messages`).textContent();
    const refreshEnabled = () => page.getByTestId("refresh-budgets").isEnabled();
    const setRoomMessages = (messages: number) => owner.api.budgets.set({ budgets: { messages } });
    const settle = () => page.evaluate(() => new Promise<void>((done) => setTimeout(done, 250)));
    // Older reads answered last: their stale answers arrive after the newest one is shown.
    {
      const hold = await holdBudgetReads(page, observer.id);
      await page.getByTestId("refresh-budgets").click();
      await hold.readSeeing(8);
      await setRoomMessages(9);
      const newest = await hold.newest();
      expect(newest.sawLimit).toBe(9);
      const older = hold.reads.filter((read) => read !== newest);
      newest.release();
      await expect.poll(shownLimit).toContain("of 9 per minute");
      for (const read of older) read.release();
      await Promise.all(older.map((read) => read.delivered));
      await settle();
      expect(await shownLimit()).toContain("of 9 per minute");
      await hold.finish();
      await expect.poll(refreshEnabled).toBe(true);
    }
    // Older reads answered first: they must not end "loading" while the newest read is in flight.
    {
      const hold = await holdBudgetReads(page, observer.id);
      await page.getByTestId("refresh-budgets").click();
      await hold.readSeeing(9);
      await setRoomMessages(10);
      const newest = await hold.newest();
      expect(newest.sawLimit).toBe(10);
      const older = hold.reads.filter((read) => read !== newest);
      for (const read of older) read.release();
      await Promise.all(older.map((read) => read.delivered));
      await settle();
      expect(await shownLimit()).toContain("of 9 per minute"); // a superseded answer is not shown
      expect(await refreshEnabled()).toBe(false); // the newest read is still in flight
      newest.release();
      await expect.poll(shownLimit).toContain("of 10 per minute");
      await hold.finish();
      await expect.poll(refreshEnabled).toBe(true);
    }
    await setRoomMessages(8);
    await expect.poll(shownLimit).toContain("of 8 per minute");
    await expect
      .poll(() => page.getByTestId(`compute-usage-${agentA.id}`).textContent())
      .toContain("Sandbox CPU: 0 used, 0 reserved of 2 vCPU-hours/day");

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
    const removed = await fixture.db.pool.query<{ status: string }>(
      "SELECT status FROM participants WHERE id = $1",
      [observer.id],
    );
    expect(removed.rows[0]?.status).toBe("REMOVED");

    await page.getByTestId("freeze-room").click();
    await expect.poll(() => page.getByTestId("owner-room-status").textContent()).toBe("PAUSED");
    await page.getByTestId("resume-room").click();
    await expect.poll(() => page.getByTestId("owner-room-status").textContent()).toBe("ACTIVE");

    await page.getByTestId("tab-delivery").click();
    const activeDownloadPromise = page.waitForEvent("download");
    await page.getByTestId("export-room").click();
    expect((await activeDownloadPromise).suggestedFilename()).toContain("export.tar.gz");
    await expect
      .poll(() => page.getByTestId("room-export-notice").textContent())
      .toBe("Room export downloaded.");
    await page.getByTestId("tab-owner-controls").click();
    await page.getByTestId("archive-room").click();
    await expect.poll(() => page.getByTestId("owner-room-status").textContent()).toBe("ARCHIVED");
    await expect.poll(() => page.getByTestId("archive-room").count()).toBe(0);
    await page.getByTestId("tab-delivery").click();
    const archivedDownloadPromise = page.waitForEvent("download");
    await page.getByTestId("export-room").click();
    expect((await archivedDownloadPromise).suggestedFilename()).toContain("export.tar.gz");
    await expect
      .poll(() => page.getByTestId("room-export-notice").textContent())
      .toBe("Room export downloaded.");
    await expect
      .poll(async () => {
        const exports = await fixture.db.pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM events WHERE room_id = $1 AND type = 'room.exported'",
          [roomId],
        );
        return exports.rows[0]?.count;
      })
      .toBe(2);
    expect(confirmationMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Use this command for room health checks?"),
        "Save the room health settings?",
        "Clear the room health command?",
        "Replace the room's default limits for every agent?",
        expect.stringContaining("registry.acme.test, *.packages.example"),
        expect.stringContaining("infra/release/**, .github/workflows/**"),
        expect.stringContaining("Grant tasks.create to ObserverAgent with approval required"),
        expect.stringContaining("Approve tasks.create from ObserverAgent"),
        expect.stringContaining("Rejected gated work"),
        expect.stringContaining("Revoke tasks.create from ObserverAgent"),
        expect.stringContaining("ObserverAgent"),
        expect.stringContaining("Project Alpha"),
        "Archive Project Alpha? It will become read-only and its data will be permanently deleted after 365 days, following a 7-day notice.",
      ]),
    );
    await guestPage.close();

    expect(problems).toEqual([]);
    await page.getByTestId("sign-out").click();
    await page.getByTestId("login-name").waitFor();
  }, 120_000);
}

export function registerWebOwnerRoleChanges(fixture: WebFixture): void {
  it("lets the owner change their own role in Owner controls after appointing a new lead", async () => {
    const page: Page = await fixture.browser!.newPage();
    const confirmations: string[] = [];
    page.on("dialog", (dialog) => {
      confirmations.push(dialog.message());
      void dialog.accept();
    });

    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("RoleOwner");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Owner role controls");
    await page.getByTestId("room-objective").fill("Change a participant role from the browser");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
    const login = await client.devLogin({ subject: "RoleOwner", display_name: "RoleOwner" });
    const ownerSession = await client.roomSession(login.session_token, roomId);
    const owner = client.room(roomId, ownerSession.tokens.access_token);
    const invite = await owner.api.room.invite<unknown>({ role: "DEVELOPER" });
    const joined = await client.join(roomId, {
      token: (invite.one_time as { token: string }).token,
      manifest: manifest("RoleAgent"),
    });
    const agentId = (joined as unknown as { participant_id: string }).participant_id;

    await page.getByTestId("tab-setup").click();
    await page.getByTestId("lead-participant").selectOption(agentId);
    await page.getByTestId("appoint-lead").click();
    await expect
      .poll(() => page.getByTestId("lead-status").textContent())
      .toContain("now the lead");

    await page.getByTestId("tab-owner-controls").click();
    await page.getByTestId("role-participant").selectOption(ownerSession.participant_id);
    await page.getByTestId("participant-role-value").selectOption("REVIEWER");
    await page.getByTestId("change-participant-role").click();
    await expect
      .poll(() => page.getByTestId("owner-controls-notice").textContent())
      .toContain("complete");

    const participant = await fixture.db.pool.query<{ role: string; authority: string }>(
      "SELECT role, authority FROM participants WHERE id = $1",
      [ownerSession.participant_id],
    );
    expect(participant.rows[0]).toEqual({ role: "REVIEWER", authority: "OWNER" });
    expect(confirmations).toContain("Change your role from DEVELOPER to REVIEWER?");

    await page.getByTestId("tab-overview").click();
    const ownerRow = page.locator('[data-name="RoleOwner"]');
    await expect
      .poll(() => ownerRow.locator("td").nth(2).textContent())
      .toContain("REVIEWER / OWNER");
    await page.close();
  }, 120_000);
}

export function registerWebTaskReview(fixture: WebFixture): void {
  it("shows task evidence and missing requirements so the lead can review the task", async () => {
    const page = await fixture.browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (entry) => {
      if (entry.type() === "error") problems.push(`console: ${entry.text()}`);
    });

    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Task Review");
    await page.getByTestId("room-objective").fill("Review evidence and export a checkpoint");
    await page.getByTestId("room-create").click();
    await expect.poll(async () => page.getByTestId("room-title").textContent()).toBe("Task Review");
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
    const login = await client.devLogin({ subject: "Peter", display_name: "Peter" });
    const owner: RoomClient = client.room(
      roomId,
      (await client.roomSession(login.session_token, roomId)).tokens.access_token,
    );
    const ownerId = (
      await fixture.db.pool.query("SELECT owner_id FROM rooms WHERE id = $1", [roomId])
    ).rows[0].owner_id as string;
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

  it("lets a task owner block, unblock and release work from the board", async () => {
    const page = await fixture.browser!.newPage();
    const confirmations: string[] = [];
    const pageErrors: string[] = [];
    let acceptRelease = false;
    page.on("dialog", (dialog) => {
      confirmations.push(dialog.message());
      void (acceptRelease ? dialog.accept() : dialog.dismiss());
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("Task controls owner");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Task controls");
    await page.getByTestId("room-objective").fill("Exercise task block, unblock and release");
    await page.getByTestId("room-create").click();
    await expect
      .poll(async () => page.getByTestId("room-title").textContent())
      .toBe("Task controls");
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
    const login = await client.devLogin({
      subject: "Task controls owner",
      display_name: "Task controls owner",
    });
    const owner = client.room(
      roomId,
      (await client.roomSession(login.session_token, roomId)).tokens.access_token,
    );

    await page.getByTestId("tab-tasks").click();
    await page.getByTestId("task-title").fill("Browser task controls");
    await page.getByTestId("task-requirements").fill("Exercise lifecycle controls");
    await page.getByTestId("task-create").click();
    const taskCard = page.getByTestId("task").filter({ hasText: "Browser task controls" });
    await expect.poll(async () => taskCard.count()).toBe(1);
    await taskCard.getByTestId("task-claim").click();
    await expect.poll(() => page.getByTestId("column-CLAIMED").getByTestId("task").count()).toBe(1);

    const pageTasks = await owner.api.tasks.list<{
      tasks: { id: string; title: string; version: number }[];
    }>({ limit: 100 });
    const task = pageTasks.response.tasks.find((entry) => entry.title === "Browser task controls");
    expect(task).toBeDefined();
    if (!task) throw new Error("The browser-created task was not returned by tasks.list");
    await owner.api.tasks.start({
      task_id: task.id,
      expected_version: task.version,
    });
    await expect
      .poll(() => page.getByTestId("column-IN_PROGRESS").getByTestId("task").count())
      .toBe(1);

    await taskCard.getByTestId("task-block-reason").fill("Waiting for a dependency");
    await taskCard.getByTestId("task-block").click();
    await expect.poll(() => page.getByTestId("column-BLOCKED").getByTestId("task").count()).toBe(1);
    await expect
      .poll(() => taskCard.getByTestId("task-blocked-reason").textContent())
      .toContain("Waiting for a dependency");
    await taskCard.getByTestId("task-unblock").click();
    await expect
      .poll(() => page.getByTestId("column-IN_PROGRESS").getByTestId("task").count())
      .toBe(1);

    await taskCard.getByTestId("task-block-reason").fill("Releasing blocked work");
    await taskCard.getByTestId("task-block").click();
    await expect.poll(() => page.getByTestId("column-BLOCKED").getByTestId("task").count()).toBe(1);
    await taskCard.getByTestId("task-release").click();
    expect(confirmations).toContain(
      "Release “Browser task controls” back to the board? Its owner and blocked reason will be cleared.",
    );
    await expect.poll(() => page.getByTestId("column-BLOCKED").getByTestId("task").count()).toBe(1);
    acceptRelease = true;
    await taskCard.getByTestId("task-release").click();
    await expect.poll(() => page.getByTestId("column-OPEN").getByTestId("task").count()).toBe(1);
    await expect.poll(async () => (await taskCard.textContent()) ?? "").toContain("unassigned");
    const released = await owner.api.tasks.get<{
      status: string;
      owner_id: string | null;
      blocked_reason: string | null;
    }>({ task_id: task.id });
    expect(released.response).toMatchObject({
      status: "OPEN",
      owner_id: null,
      blocked_reason: null,
    });
    expect(pageErrors).toEqual([]);
    await page.close();
  }, 60_000);

  it("lets a task owner start and submit evidence from the Tasks tab", async () => {
    const page = await fixture.browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (entry) => {
      if (
        entry.type() === "error" &&
        !entry.text().includes("status of 403") &&
        !entry.text().includes("status of 409")
      )
        problems.push(`console: ${entry.text()}`);
    });

    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("Task execution owner");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Task execution");
    await page.getByTestId("room-objective").fill("Run a task through review from the web UI");
    await page.getByTestId("room-create").click();
    await expect
      .poll(async () => page.getByTestId("room-title").textContent())
      .toBe("Task execution");
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
    const login = await client.devLogin({
      subject: "Task execution owner",
      display_name: "Task execution owner",
    });
    const owner: RoomClient = client.room(
      roomId,
      (await client.roomSession(login.session_token, roomId)).tokens.access_token,
    );
    const invite = await owner.api.room.invite<unknown>({ role: "REVIEWER" });
    const joined = await client.join(roomId, {
      token: (invite.one_time as { token: string }).token,
      manifest: manifest("TaskReviewer"),
    });
    const reviewerId = (joined as unknown as { participant_id: string }).participant_id;
    const reviewer = client.room(roomId, joined.tokens.access_token);

    await page.getByTestId("tab-tasks").click();
    await page.getByTestId("task-title").fill("Browser task execution");
    await page.getByTestId("task-requirements").fill("Focused tests pass\nRendered result checked");
    await page.getByTestId("task-create").click();
    const taskCard = page.getByTestId("task").filter({ hasText: "Browser task execution" });
    await expect.poll(async () => taskCard.count()).toBe(1);
    await taskCard.getByTestId("task-claim").click();
    await expect.poll(async () => taskCard.textContent()).toContain("Task execution owner");

    const taskPage = await owner.api.tasks.list<{
      tasks: { id: string; title: string; version: number }[];
    }>({ limit: 100 });
    const task = taskPage.response.tasks.find((entry) => entry.title === "Browser task execution");
    expect(task).toBeDefined();
    if (!task) throw new Error("The browser-created task was not returned by tasks.list");

    const commandUrl = "**/v1/rooms/*/commands";
    let advancedDuringStart = false;
    const makeStartStale = async (route: Route) => {
      const request = route.request().postDataJSON() as {
        method?: string;
        params?: { task_id?: string; expected_version?: number };
      };
      if (request.method === "tasks.start" && !advancedDuringStart) {
        advancedDuringStart = true;
        expect(request.params?.task_id).toBe(task.id);
        const update = await owner.api.tasks.update<{ version: number }>({
          task_id: task.id,
          expected_version: request.params!.expected_version!,
          reviewer_id: reviewerId,
        });
        expect(update.response.version).toBeGreaterThan(request.params!.expected_version!);
      }
      await route.continue();
    };
    await page.route(commandUrl, makeStartStale);
    await taskCard.getByTestId("task-start").click();
    await expect
      .poll(async () => page.getByTestId("notice").textContent())
      .toContain("Task was updated by another participant");
    await page.unroute(commandUrl, makeStartStale);
    expect(advancedDuringStart).toBe(true);
    await expect.poll(async () => taskCard.getByTestId("task-start").isEnabled()).toBe(true);

    const finishStartRefusal = await refuseNextCommand(page, "tasks.start");
    await taskCard.getByTestId("task-start").click();
    await expect
      .poll(async () => page.getByTestId("notice").textContent())
      .toContain("The server refused this action");
    await finishStartRefusal();

    await taskCard.getByTestId("task-start").click();
    await expect
      .poll(async () => page.getByTestId("column-IN_PROGRESS").getByTestId("task").count())
      .toBe(1);
    await taskCard.getByTestId("task-evidence-ref-0").fill("vitest: task execution suite");
    await taskCard.getByTestId("task-evidence-kind-0").selectOption("test");
    await taskCard.getByTestId("task-evidence-ref-1").fill("browser: result verified");
    await taskCard.getByTestId("task-evidence-kind-1").selectOption("manual");
    await taskCard.getByTestId("task-submit").click();
    await expect
      .poll(async () => page.getByTestId("column-REVIEW").getByTestId("task").count())
      .toBe(1);

    await page.getByTestId("tab-delivery").click();
    const reviewTask = page.getByTestId("review-task").filter({
      hasText: "Browser task execution",
    });
    await expect.poll(async () => reviewTask.count()).toBe(1);
    await expect
      .poll(async () => (await reviewTask.getByTestId("task-evidence").allTextContents()).join(" "))
      .toContain("vitest: task execution suite");
    await expect
      .poll(async () => reviewTask.getByTestId("task-missing-evidence").textContent())
      .toContain("All requirements have evidence.");

    const submitted = await owner.api.tasks.get<{ version: number }>({ task_id: task.id });
    await reviewer.api.tasks.review({
      task_id: task.id,
      expected_version: submitted.response.version,
      verdict: "approve",
      comments: "Both requirements have evidence.",
    });
    const completed = await owner.api.tasks.get<{ status: string }>({ task_id: task.id });
    expect(completed.response.status).toBe("DONE");
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);
}

export function registerWebDecisionsAndInbox(fixture: WebFixture): void {
  it("T1402 step 5: decide in the browser and read the memory mirror", async () => {
    const page: Page = await fixture.browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (entry) => {
      if (
        entry.type() === "error" &&
        !entry.text().includes("status of 403") &&
        !entry.text().includes("status of 409") &&
        !entry.text().includes("status of 500")
      )
        problems.push(`console: ${entry.text()}`);
    });

    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Decisions room");
    await page.getByTestId("room-objective").fill("Decisions and shared memory in the browser");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
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
    await expect.poll(() => page.getByTestId("decision-detail").textContent()).toContain("HUMAN");
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
    await expect.poll(() => page.getByTestId("memory-detail").textContent()).toContain("SYSTEM");

    const finishMemoryRefusal = await refuseNextCommand(page, "memory.put");
    await page.getByTestId("memory-write-key").fill("notes/browser-auth");
    await page.getByTestId("memory-write-value").fill("Keep the browser session short-lived.");
    await page.getByTestId("memory-write-type").selectOption("text/markdown");
    await page.getByTestId("memory-source-refs").fill(`decision:${decisionId}`);
    await page.getByTestId("memory-write").click();
    await expect
      .poll(() => page.getByTestId("collaboration-notice").textContent())
      .toContain("The server refused this action");
    await finishMemoryRefusal();
    await page.getByTestId("memory-write").click();
    await expect
      .poll(() => page.getByTestId("memory-detail").textContent())
      .toContain("Keep the browser session short-lived.");
    await page.getByTestId("memory-write-value").fill("Refresh the browser session carefully.");
    await page.getByTestId("memory-write").click();
    await expect
      .poll(() => page.getByTestId("memory-detail").textContent())
      .toContain("Refresh the browser session carefully.");
    await expect.poll(() => page.getByTestId("memory-history").textContent()).toContain("r2");

    // T1559: a memory.* event makes the page re-read the entry that was selected a moment ago. That
    // read can answer after the read of the entry that was just written, and must not replace it.
    // The put's response is held until the event's read of the old entry has been answered, which
    // forces that order; the old read is then delivered last.
    const raceNote = "Written while the old entry's read was in flight.";
    await mirror.click();
    await expect
      .poll(() => page.getByTestId("memory-detail").textContent())
      .toContain("Session tokens or JWT");
    const memoryHold = await holdCommands(
      page,
      (method, params) =>
        method === "memory.put" ||
        (method === "memory.get" && params["key"] === `decisions/${decisionId}`),
    );
    await page.getByTestId("memory-write-key").fill("notes/race-check");
    await page.getByTestId("memory-write-value").fill(raceNote);
    await page.getByTestId("memory-write-type").selectOption("text/markdown");
    await page.getByTestId("memory-source-refs").fill(`decision:${decisionId}`);
    await page.getByTestId("memory-write").click();
    const [put] = await memoryHold.answered("memory.put");
    const oldReads = await memoryHold.answered("memory.get");
    put!.release();
    await expect.poll(() => page.getByTestId("memory-detail").textContent()).toContain(raceNote);
    for (const read of oldReads) read.release();
    await Promise.all(oldReads.map((read) => read.delivered));
    await settle(page);
    expect(await page.getByTestId("memory-detail").textContent()).toContain(raceNote);
    await memoryHold.finish();

    // T1559: a click on a key whose read answers after a later click must not fill the write form
    // with the earlier key: the next write would target an entry that is not selected.
    const formHold = await holdCommands(
      page,
      (method, params) => method === "memory.get" && params["key"] === "notes/browser-auth",
    );
    await page.getByTestId("memory-key").filter({ hasText: "notes/browser-auth" }).click();
    const [earlierRead] = await formHold.answered("memory.get");
    await page.getByTestId("memory-key").filter({ hasText: "notes/race-check" }).click();
    await expect.poll(() => page.getByTestId("memory-detail").textContent()).toContain(raceNote);
    await expect
      .poll(() => page.getByTestId("memory-write-key").inputValue())
      .toBe("notes/race-check");
    earlierRead!.release();
    await earlierRead!.delivered;
    await settle(page);
    expect(await page.getByTestId("memory-write-key").inputValue()).toBe("notes/race-check");
    expect(await page.getByTestId("memory-detail").textContent()).toContain(raceNote);
    await formHold.finish();

    // T1559: two memory.* events for the selected key make two reads of it. The first is slow and
    // fails after the second has answered; its failure must not empty the pane the second filled.
    let heldFirstRead = false;
    const failHold = await holdCommands(page, (method, params) => {
      if (method !== "memory.get" || params["key"] !== "notes/race-check" || heldFirstRead)
        return false;
      return (heldFirstRead = true);
    });
    const current = await owner.api.memory.get<{ revision: number }>({ key: "notes/race-check" });
    const firstNote = "First change from outside the page.";
    const secondNote = "Second change from outside the page.";
    const putOutside = (value: string, expected_revision: number) =>
      owner.api.memory.put({
        key: "notes/race-check",
        value,
        content_type: "text/markdown",
        source_refs: [{ kind: "decision", id: decisionId }],
        expected_revision,
      });
    await putOutside(firstNote, current.response.revision);
    const [slowRead] = await failHold.answered("memory.get");
    await putOutside(secondNote, current.response.revision + 1);
    await expect.poll(() => page.getByTestId("memory-detail").textContent()).toContain(secondNote);
    slowRead!.fail();
    await slowRead!.delivered;
    await settle(page);
    expect(await page.getByTestId("memory-detail").textContent()).toContain(secondNote);
    // ... and the superseded read's failure is not reported beside the newer read's answer.
    expect(await page.getByTestId("collaboration-notice").count()).toBe(0);
    await failHold.finish();

    // T1559: the click read of the selected key answers after the read an event started, so the
    // write form is filled from the older entry while the pane already shows the newer one. Saving
    // must compare against the revision the form was filled from, and so be refused, not overwrite.
    let heldClickRead = false;
    const draftHold = await holdCommands(page, (method, params) => {
      if (method !== "memory.get" || params["key"] !== "notes/race-check" || heldClickRead)
        return false;
      return (heldClickRead = true);
    });
    const before = await owner.api.memory.get<{ revision: number }>({ key: "notes/race-check" });
    await page.getByTestId("memory-key").filter({ hasText: "notes/race-check" }).click();
    const [clickRead] = await draftHold.answered("memory.get");
    const newestNote = "Newest change, written while the click read was in flight.";
    await putOutside(newestNote, before.response.revision);
    await expect.poll(() => page.getByTestId("memory-detail").textContent()).toContain(newestNote);
    clickRead!.release();
    await clickRead!.delivered;
    await settle(page);
    await page.getByTestId("memory-write").click();
    await expect
      .poll(async () => (await page.getByTestId("collaboration-notice").count()) > 0)
      .toBe(true);
    const after = await owner.api.memory.get<{ value: string }>({ key: "notes/race-check" });
    expect(after.response.value).toBe(newestNote);
    await draftHold.finish();

    // T1559: a participant writes the key between this page's write and its refresh of the pane.
    // The form still holds this page's own write, so the next save must compare against that
    // write's revision, not the newer one the refresh shows, and be refused.
    await page.getByTestId("memory-key").filter({ hasText: "notes/race-check" }).click();
    await expect.poll(() => page.getByTestId("memory-write-value").inputValue()).toBe(newestNote);
    let heldOwnWrite = false;
    const ownWriteHold = await holdCommands(page, (method) => {
      if (method !== "memory.put" || heldOwnWrite) return false;
      return (heldOwnWrite = true);
    });
    const ownNote = "This page's own write.";
    const participantNote = "A participant's write between the page's write and its refresh.";
    await page.getByTestId("memory-write-value").fill(ownNote);
    await page.getByTestId("memory-write").click();
    const [ownWrite] = await ownWriteHold.answered("memory.put");
    const written = await owner.api.memory.get<{ revision: number }>({ key: "notes/race-check" });
    await putOutside(participantNote, written.response.revision);
    await expect
      .poll(() => page.getByTestId("memory-detail").textContent())
      .toContain(participantNote);
    ownWrite!.release();
    await ownWrite!.delivered;
    await settle(page);
    await page.getByTestId("memory-write").click();
    await expect
      .poll(async () => (await page.getByTestId("collaboration-notice").count()) > 0)
      .toBe(true);
    const final = await owner.api.memory.get<{ value: string }>({ key: "notes/race-check" });
    expect(final.response.value).toBe(participantNote);
    await ownWriteHold.finish();

    await page.getByTestId("collab-decisions").click();
    await page
      .getByTestId("decision-veto-rationale")
      .fill("The accepted option missed an important constraint.");
    const finishVetoRefusal = await refuseNextCommand(page, "decisions.veto");
    await page.getByTestId("decision-veto").click();
    await expect
      .poll(() => page.getByTestId("collaboration-notice").textContent())
      .toContain("The server refused this action");
    await finishVetoRefusal();
    await page.getByTestId("decision-veto").click();
    await expect.poll(() => page.getByTestId("decision-detail").textContent()).toContain("VETOED");

    await page.getByTestId("decision-title").fill("A proposal to withdraw");
    await page.getByTestId("decision-context").fill("This proposal is no longer needed.");
    await page.getByTestId("decision-options").fill("Keep it\nDrop it");
    await page.getByTestId("decision-propose").click();
    await expect
      .poll(() => page.getByTestId("decision-detail").textContent())
      .toContain("A proposal to withdraw");
    await page.getByTestId("decision-withdraw").click();
    await expect
      .poll(() => page.getByTestId("decision-detail").textContent())
      .toContain("WITHDRAWN");

    // T1559: the same for the decision pane. A decision.* event makes the page re-read the decision
    // that was selected before; its answer must not replace the one just proposed.
    const withdrawnId = (
      await owner.api.decisions.list<{ decisions: { id: string; title: string }[] }>({ limit: 100 })
    ).response.decisions.find((decision) => decision.title === "A proposal to withdraw")!.id;
    const decisionHold = await holdCommands(
      page,
      (method, params) =>
        method === "decisions.propose" ||
        (method === "decisions.get" && params["decision_id"] === withdrawnId),
    );
    await page.getByTestId("decision-title").fill("Another proposal");
    await page
      .getByTestId("decision-context")
      .fill("Proposed while the old decision's read is in flight.");
    await page.getByTestId("decision-options").fill("Yes\nNo");
    await page.getByTestId("decision-propose").click();
    const [proposed] = await decisionHold.answered("decisions.propose");
    const oldDecisionReads = await decisionHold.answered("decisions.get");
    proposed!.release();
    await expect
      .poll(() => page.getByTestId("decision-detail").textContent())
      .toContain("Another proposal");
    for (const read of oldDecisionReads) read.release();
    await Promise.all(oldDecisionReads.map((read) => read.delivered));
    await settle(page);
    expect(await page.getByTestId("decision-detail").textContent()).toContain("Another proposal");
    await decisionHold.finish();

    expect(problems).toEqual([]);
    await page.close();
  }, 120_000);

  it("T1402 step 13: a failing health run appears in the author's inbox and can be acknowledged", async () => {
    const page: Page = await fixture.browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (entry) => {
      if (entry.type() === "error") problems.push(`console: ${entry.text()}`);
    });

    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("Health author");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Health inbox room");
    await page.getByTestId("room-objective").fill("Surface and acknowledge failing health runs");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
    const login = await client.devLogin({
      subject: "Health author",
      display_name: "Health author",
    });
    const session = await client.roomSession(login.session_token, roomId);
    const owner: RoomClient = client.room(roomId, session.tokens.access_token);
    await page.getByTestId("tab-collaboration").click();
    await page.getByTestId("collab-inbox").click();

    // A separate participant mentions the inbox owner while the browser is already open. The
    // non-health item must arrive through the live event subscription, without a manual refresh.
    const invite = await owner.api.room.invite<unknown>({ role: "DEVELOPER" });
    const joined = await client.join(roomId, {
      token: (invite.one_time as { token: string }).token,
      manifest: manifest("Mentioner"),
    });
    const mentioner = client.room(roomId, joined.tokens.access_token);
    await mentioner.api.messages.send({
      body: "Health author, please review this note.",
      mentions: [session.participant_id],
    });
    await expect
      .poll(() => page.getByTestId("inbox-list").textContent(), { timeout: 10_000 })
      .toContain("MENTION");
    await page.getByTestId("inbox-ack").click();
    await expect
      .poll(() => page.getByTestId("inbox-list").textContent())
      .toContain("No unacknowledged inbox items.");

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
          const { rows } = await fixture.db.pool.query<{ status: string }>(
            "SELECT status FROM health_runs WHERE room_id = $1 AND revision = $2 ORDER BY created_at DESC LIMIT 1",
            [roomId, revision],
          );
          return rows[0]?.status ?? null;
        },
        { timeout: 90_000 },
      )
      .toBe("RED");
    await expect.poll(() => page.getByTestId("workspace-health").textContent()).toContain("RED");
    await expect
      .poll(() => page.getByTestId("workspace-revision").textContent())
      .toContain(String(revision));
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

  it("T1502: the live message channel sends mentions and task, decision and file references", async () => {
    const page: Page = await fixture.browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (entry) => {
      if (entry.type() === "error" && !entry.text().includes("status of 403"))
        problems.push(`console: ${entry.text()}`);
    });

    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("Message owner");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Messages room");
    await page.getByTestId("room-objective").fill("Try the live message channel");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
    const login = await client.devLogin({
      subject: "Message owner",
      display_name: "Message owner",
    });
    const session = await client.roomSession(login.session_token, roomId);
    const owner = client.room(roomId, session.tokens.access_token);
    const invite = await owner.api.room.invite<unknown>({ role: "DEVELOPER" });
    const joined = await client.join(roomId, {
      token: (invite.one_time as { token: string }).token,
      manifest: manifest("Message agent"),
    });
    const agentId = (joined as unknown as { participant_id: string }).participant_id;
    const agent = client.room(roomId, joined.tokens.access_token);
    const workspace = await owner.api.workspace.list<{ workspace_revision: number }>();
    await owner.api.workspace.apply_changeset({
      source: "API",
      message: "Seed file reference",
      base_workspace_revision: workspace.response.workspace_revision,
      operations: [{ type: "create", path: "src/auth.ts", content: "export const auth = true;\n" }],
    });
    const task = await owner.api.tasks.create<{ id: string }>({
      title: "Review authentication",
      requirements: ["Check the login flow"],
    });
    await owner.api.decisions.propose({
      title: "Choose a token format",
      context: "Pick the format for the login flow.",
      options: [{ summary: "JWT" }, { summary: "Session token" }],
    });
    const decision = (
      await owner.api.decisions.list<{ decisions: { id: string; title: string }[] }>({ limit: 100 })
    ).response.decisions.find((item) => item.title === "Choose a token format")!;

    await page.getByTestId("tab-messages").click();
    await expect
      .poll(() =>
        page
          .getByTestId("message-mention-picker")
          .locator("option")
          .filter({ hasText: "Message agent" })
          .count(),
      )
      .toBe(1);
    await page.getByTestId("message-mention-picker").selectOption(agentId);
    const messageBody =
      'Please review authentication. @Message agent <img src=x onerror="window.__messageXss=1">';
    await page.getByTestId("message-body").fill(messageBody);
    await expect
      .poll(() =>
        page
          .getByTestId("message-reference-target")
          .locator("option")
          .filter({ hasText: "Review authentication" })
          .count(),
      )
      .toBe(1);
    await page.getByTestId("message-reference-kind").selectOption("task");
    await page.getByTestId("message-reference-target").selectOption(task.response.id);
    await page.getByTestId("message-add-reference").click();
    await page.getByTestId("message-reference-kind").selectOption("decision");
    await expect
      .poll(() =>
        page
          .getByTestId("message-reference-target")
          .locator("option")
          .filter({ hasText: "Choose a token format" })
          .count(),
      )
      .toBe(1);
    await page.getByTestId("message-reference-target").selectOption(decision.id);
    await page.getByTestId("message-add-reference").click();
    await page.getByTestId("message-reference-kind").selectOption("file");
    await page.getByTestId("message-file-target").selectOption("src");
    await expect
      .poll(() =>
        page
          .getByTestId("message-file-target")
          .locator("option")
          .filter({ hasText: "auth.ts" })
          .count(),
      )
      .toBe(1);
    await page.getByTestId("message-file-target").selectOption("src/auth.ts");
    await page.getByTestId("message-add-reference").click();
    const finishMessageRefusal = await refuseNextCommand(page, "messages.send");
    await page.getByTestId("message-send").click();
    await expect
      .poll(() => page.getByTestId("messages-notice").textContent())
      .toContain("The server refused this action");
    await finishMessageRefusal();
    await page.getByTestId("message-send").click();

    await expect.poll(() => page.getByTestId("message-list").textContent()).toContain(messageBody);
    await expect.poll(() => page.getByTestId("message-list").textContent()).toContain("HUMAN");
    await expect
      .poll(() => page.getByTestId("message-list").textContent())
      .toContain("task: Review authentication");
    await expect
      .poll(() => page.getByTestId("message-list").textContent())
      .toContain("decision: Choose a token format");
    await expect
      .poll(() => page.getByTestId("message-list").textContent())
      .toContain("file: src/auth.ts");
    const shownMessage = page.getByTestId("room-message").first().locator("p");
    await expect.poll(() => shownMessage.textContent()).toBe(messageBody);
    expect(await shownMessage.locator("img").count()).toBe(0);
    expect(
      await page.evaluate(
        () => (globalThis as typeof globalThis & { __messageXss?: number }).__messageXss,
      ),
    ).toBeUndefined();
    await expect
      .poll(
        async () =>
          (
            await agent.api.inbox.list<{ items: { kind: string; summary: string }[] }>({
              unacked_only: true,
            })
          ).response.items.some((item) => item.kind === "MENTION" && item.summary === messageBody),
        { timeout: 10_000 },
      )
      .toBe(true);

    await agent.api.messages.send({ body: "I see it and will review the login flow." });
    const agentReply = page
      .getByTestId("room-message")
      .filter({ hasText: "I see it and will review the login flow." });
    await expect
      .poll(() => agentReply.textContent())
      .toContain("From Message agent · AGENT · trust: participant");
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);
}
