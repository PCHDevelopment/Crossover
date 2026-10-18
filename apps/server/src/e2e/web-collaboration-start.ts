import { DEFAULT_PROTECTED_PATHS } from "@crossover/protocol";
import { CrossoverClient, type RoomClient } from "@crossover/sdk";
import { manifest, type WebFixture } from "./web-fixture.js";
import { holdBudgetReads } from "./web-holds.js";
import { refuseNextCommand } from "./web-refusal.js";
import type { Page, Route } from "playwright-core";
import { expect, it } from "vitest";

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
