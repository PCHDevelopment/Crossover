import { CrossoverClient, type RoomClient } from "@crossover/sdk";
import { manifest, type WebFixture } from "./web-fixture.js";
import { holdCommands, settle } from "./web-holds.js";
import { refuseNextCommand } from "./web-refusal.js";
import type { Page } from "playwright-core";
import { expect, it } from "vitest";

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
