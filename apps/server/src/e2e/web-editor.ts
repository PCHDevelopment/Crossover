import { CrossoverClient } from "@crossover/sdk";
import { manifest, type WebFixture } from "./web-fixture.js";
import type { Page } from "playwright-core";
import { expect, it } from "vitest";

export function registerWebEditorTests(fixture: WebFixture): void {
  it("the editor (T1105a): open a file from the tree, edits flush as EDITOR ChangeSets on idle and on Ctrl+S, and someone else's change replaces a clean buffer", async () => {
    const page: Page = await fixture.browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });
    // What the browser sees after someone else's change (T1559): if the clean buffer doesn't follow
    // it, the failure says whether the event reached the browser and what the page's reads answered.
    const seen: string[] = [];
    let remoteChangeAt = 0;
    const since = () => `+${Date.now() - remoteChangeAt}ms`;
    page.on("websocket", (socket) =>
      socket.on("framereceived", (frame) => {
        const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString();
        if (remoteChangeAt && text.includes("workspace.changeset.applied"))
          seen.push(`event frame ${since()}`);
      }),
    );
    page.on("response", async (response) => {
      if (!remoteChangeAt || !response.url().endsWith("/commands")) return;
      if (!(response.request().postData() ?? "").includes('"workspace.read"')) return;
      const body = await response.text().catch(() => "");
      seen.push(`workspace.read ${response.status()} ${since()} ${body.slice(0, 60)}`);
    });
    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Editor room");
    await page.getByTestId("room-objective").fill("Edit files");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    // An agent (here: Peter from code) puts a file in the workspace.
    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
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
    const sources = await fixture.db.pool.query(
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
    remoteChangeAt = Date.now();
    const shout = await api.workspace.apply_changeset<{ status: string }>({
      source: "API",
      message: "Shout",
      base_workspace_revision: current.response.workspace_revision,
      base_file_revisions: { "src/notes.txt": current.response.file_revision },
      operations: [{ type: "modify", path: "src/notes.txt", content: final.replace("one", "ONE") }],
    });
    expect(shout.response.status).toBe("APPLIED");
    try {
      await expect.poll(async () => lines.textContent(), { timeout: 10_000 }).toContain("ONE");
    } catch (error) {
      throw new Error(
        `The clean buffer did not follow the remote change. Seen by the browser since it was ` +
          `applied: ${seen.length ? seen.join("; ") : "nothing"}. Buffer: ` +
          `${JSON.stringify(await lines.textContent())}`,
        { cause: error },
      );
    }
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
    const page: Page = await fixture.browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });
    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Presence room");
    await page.getByTestId("room-objective").fill("See each other");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
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
    const page: Page = await fixture.browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });
    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Overlap room");
    await page.getByTestId("room-objective").fill("Keep both");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;
    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
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
          await fixture.db.pool.query(
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
    const page: Page = await fixture.browser!.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()} @ ${m.location().url}`);
    });
    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("Peter");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Merge room");
    await page.getByTestId("room-objective").fill("Resolve conflicts");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;
    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
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
        await fixture.db.pool.query(
          "SELECT status FROM conflicts WHERE room_id = $1 ORDER BY created_at",
          [roomId],
        )
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
    await expect.poll(() => page.getByTestId("merge-conflict").count()).toBe(1);
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
}
