import { DEFAULT_PROTECTED_PATHS } from "@crossover/workspace/protected-paths";
import { CrossoverClient, type RoomClient } from "@crossover/sdk";
import { manifest, type WebFixture } from "./web-fixture.js";
import { refuseNextCommand } from "./web-refusal.js";
import type { Page } from "playwright-core";
import { expect, it } from "vitest";

export function registerWebCollaborationStart(fixture: WebFixture): void {
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
    await guestPage.goto(`${fixture.baseUrl}/rooms/${roomId}`);
    await guestPage.getByTestId("room-title").waitFor();
    await expect.poll(() => guestPage.getByTestId("tab-owner-controls").count()).toBe(0);

    const observer = await joinAgent("ObserverAgent", undefined, "OBSERVER");
    await page.getByTestId("tab-owner-controls").click();
    await page.getByTestId("owner-controls").waitFor();

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

    await page.getByTestId("room-budget-messages").fill("8");
    await page.getByTestId("save-room-budgets").click();
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
        expect.stringContaining("registry.acme.test, *.packages.example"),
        expect.stringContaining("infra/release/**, .github/workflows/**"),
        expect.stringContaining("Grant tasks.create to ObserverAgent with approval required"),
        expect.stringContaining("Approve tasks.create from ObserverAgent"),
        expect.stringContaining("Rejected gated work"),
        expect.stringContaining("Revoke tasks.create from ObserverAgent"),
        expect.stringContaining("ObserverAgent"),
        expect.stringContaining("Project Alpha"),
        "Archive Project Alpha? This cannot be undone; the room will become read-only.",
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
}

export function registerWebDecisionsAndInbox(fixture: WebFixture): void {
  it("T1402 step 5: decide in the browser and read the memory mirror", async () => {
    const page: Page = await fixture.browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (entry) => {
      if (entry.type() === "error" && !entry.text().includes("status of 403"))
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
      if (entry.type() === "error") problems.push(`console: ${entry.text()}`);
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
    await page.getByTestId("message-send").click();

    await expect.poll(() => page.getByTestId("message-list").textContent()).toContain(messageBody);
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
      .toContain("From Message agent · trust: participant");
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);
}
