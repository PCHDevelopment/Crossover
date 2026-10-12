import { CrossoverClient } from "@crossover/sdk";
import { manifest, type WebFixture } from "./web-fixture.js";
import type { Page } from "playwright-core";
import { expect, it } from "vitest";

export function registerWebWorkspaceTests(fixture: WebFixture): void {
  it("T1403: the Changes tab shows diffs, lets the lead resolve an escalated conflict, and approve a held ChangeSet", async () => {
    const page: Page = await fixture.browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });
    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Changes room");
    await page.getByTestId("room-objective").fill("Review ChangeSets");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
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
            await fixture.db.pool.query("SELECT status FROM conflicts WHERE id = $1", [
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
}
