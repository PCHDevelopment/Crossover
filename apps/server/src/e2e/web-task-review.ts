import { CrossoverClient, type RoomClient } from "@crossover/sdk";
import { manifest, type WebFixture } from "./web-fixture.js";
import { refuseNextCommand } from "./web-refusal.js";
import type { Route } from "playwright-core";
import { expect, it } from "vitest";

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
