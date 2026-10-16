import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher, type Authorizer } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerWorkspaceCommands } from "./apply.js";
import { git } from "./git.js";
import { provisionWorkspace } from "./provision.js";
import type { Operation } from "./operations.js";

let db: TestDatabase;
const dirs: string[] = [];
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});
async function fixture(authorize: Authorizer = allowAll) {
  const room = newId("room");
  const owner = newId("part");
  const root = await mkdtemp(join(tmpdir(), "crossover-history-test-"));
  dirs.push(root);
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1,$1,'Room','Ship',$2)",
    [room, owner],
  );
  await db.pool.query(
    "INSERT INTO participants (id, room_id, kind, display_name, authority, role, status) VALUES ($2, $1, 'HUMAN', 'Actor', 'OWNER', 'LEAD', 'ACTIVE')",
    [room, owner],
  );
  const workspace = await withTransaction(db.pool, (client) =>
    provisionWorkspace(client, room, root),
  );
  const repo = (await db.pool.query("SELECT repo_path FROM workspaces WHERE room_id = $1", [room]))
    .rows[0].repo_path as string;
  const options = { gitDir: repo, timeoutMs: 10_000 };
  const dispatcher = new Dispatcher({ pool: db.pool, authorize, nodeId: room });
  registerWorkspaceCommands(dispatcher);
  const principal = {
    room_id: room,
    participant_id: owner,
    kind: "HUMAN" as const,
    authority: "OWNER" as const,
    role: "LEAD" as const,
  };
  const dispatch = (method: string, params: Record<string, unknown>, mutating = false) =>
    dispatcher.dispatch(principal, {
      id: newId("cmd"),
      method,
      params,
      ...(mutating ? { idempotency_key: newId("cmd") } : {}),
    });
  const apply = (operations: Operation[], base = 0) =>
    dispatch(
      "workspace.apply_changeset",
      {
        source: "API",
        message: "Edit",
        base_workspace_revision: base,
        operations,
      },
      true,
    );
  return { room, workspace, repo, options, dispatch, apply, owner };
}

// Measured (T1529): idle n/a, 3x load 2203 ms; budget 7x.
it("diffs historical snapshots with literal path filters and no engine IDs or index lines", async () => {
  const f = await fixture();
  await f.apply([
    { type: "create", path: "a[1]", content: "old\nindex user text\n" },
    { type: "create", path: "a1", content: "other\n" },
  ]);
  await f.apply(
    [
      { type: "modify", path: "a[1]", content: "new\nindex user text\n" },
      { type: "modify", path: "a1", content: "changed\n" },
    ],
    1,
  );
  const commits = (await f.dispatch("workspace.history", {})).response;
  expect(JSON.stringify(commits)).not.toMatch(/\b[0-9a-f]{40}\b/);
  const head = (await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim();
  await git(["update-ref", "refs/room/canonical", `${head}~2`], f.options);
  const response = (
    await f.dispatch("workspace.diff", {
      from_revision: 1,
      to_revision: 2,
      paths: ["a[1]"],
    })
  ).response as { diff: string; from_revision: number; to_revision: number };
  expect(response).toMatchObject({ from_revision: 1, to_revision: 2 });
  expect(response.diff).toContain("-old\n+new\n index user text");
  expect(response.diff).not.toContain("changed");
  expect(response.diff).not.toMatch(/^index /m);
  expect(response.diff).not.toMatch(/\b[0-9a-f]{40}\b/);
  expect(
    (await f.dispatch("workspace.diff", { from_revision: 2, to_revision: 2 })).response,
  ).toMatchObject({ diff: "" });
  expect(
    (await f.dispatch("workspace.diff", { from_revision: 1, to_revision: 2, paths: [] })).response,
  ).toMatchObject({ diff: expect.stringContaining("changed") });
}, 20_000);

// Measured (T1529): idle n/a, 3x load 2519 ms; budget 7x.
it("paginates workspace and exact-path history, retaining deletion and revision zero", async () => {
  const f = await fixture();
  await f.apply([{ type: "create", path: "file", content: "one" }]);
  await f.apply([{ type: "create", path: "other", content: "two" }], 1);
  await f.apply([{ type: "delete", path: "file" }], 2);
  const page = (await f.dispatch("workspace.history", { limit: 2 })).response as {
    entries: { workspace_revision: number }[];
    next_before: number;
  };
  expect(page.entries.map((entry) => entry.workspace_revision)).toEqual([3, 2]);
  expect(page.next_before).toBe(2);
  const rest = (await f.dispatch("workspace.history", { before: page.next_before })).response as {
    entries: { workspace_revision: number; changeset_id: string | null }[];
    next_before: null;
  };
  expect(rest.entries.map((entry) => entry.workspace_revision)).toEqual([1, 0]);
  expect(rest.entries[1]).toMatchObject({ changeset_id: null, actor_id: null, message: null });
  expect(rest.next_before).toBeNull();
  const path = (await f.dispatch("workspace.history", { path: "file" })).response as {
    entries: Record<string, unknown>[];
  };
  expect(path.entries).toHaveLength(2);
  expect(path.entries[0]).toMatchObject({
    workspace_revision: 3,
    file_revision: 2,
    deleted: true,
    actor_id: f.owner,
    message: "Edit",
    created_at: expect.any(String),
  });
  expect(path.entries[1]).toMatchObject({ workspace_revision: 1, file_revision: 1 });
  expect(path.entries[1]).not.toHaveProperty("deleted");
  expect((await f.dispatch("workspace.history", { path: "missing" })).response).toEqual({
    entries: [],
    next_before: null,
  });
  expect((await f.dispatch("workspace.history", { before: 0 })).response).toEqual({
    entries: [],
    next_before: null,
  });
  const other = await fixture();
  expect((await other.dispatch("workspace.history", {})).response).toMatchObject({
    entries: [{ workspace_revision: 0 }],
  });
}, 20_000);

// Measured (T1529): idle n/a, 3x load 2807 ms; budget 7x.
it("returns binary summaries and hides submodule object IDs without corrupting user text", async () => {
  const f = await fixture();
  const initial = (await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim();
  await f.apply([
    { type: "create", path: "binary", content: "AAEC", encoding: "base64" },
    { type: "create", path: "text", content: `Subproject commit ${initial}\n` },
    { type: "create", path: "large", content: "x".repeat(5 * 1024 * 1024 + 1) },
  ]);
  const tree = (await git(["rev-parse", "refs/room/canonical^{tree}"], f.options)).stdout.trim();
  const listing = (await git(["ls-tree", "-z", tree], f.options)).stdout;
  const importedTree = (
    await git(["mktree", "-z"], {
      ...f.options,
      input: `${listing}160000 commit ${initial}\tmodule\0`,
    })
  ).stdout.trim();
  const commit = (
    await git(["commit-tree", importedTree], {
      ...f.options,
      input: "Import",
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    })
  ).stdout.trim();
  await db.pool.query(
    `INSERT INTO workspace_revisions (workspace_id,room_id,revision,commit_sha)
    VALUES ($1,$2,2,$3)`,
    [f.workspace, f.room, commit],
  );
  const diff = (await f.dispatch("workspace.diff", { from_revision: 0, to_revision: 2 }))
    .response as { diff: string };
  expect(diff.diff).toContain("Binary files /dev/null and b/binary differ");
  expect(diff.diff).toContain("Binary files /dev/null and b/large differ");
  expect(diff.diff).toContain("+Submodule content changed");
  expect(diff.diff).toContain(`+Subproject commit ${initial}`); // user text is preserved
  const onlyModule = (
    await f.dispatch("workspace.diff", {
      from_revision: 0,
      to_revision: 2,
      paths: ["module"],
    })
  ).response;
  expect(JSON.stringify(onlyModule)).not.toMatch(/\b[0-9a-f]{40}\b/);
}, 20_000);

it("scopes unfiltered diffs to paths the caller can read", async () => {
  const f = await fixture(async (_principal, action, resource) => {
    if (action === "workspace.read" && resource.path === "private.txt")
      throw new CrossoverError("FORBIDDEN", "Denied");
  });
  await f.apply([
    { type: "create", path: "public.txt", content: "visible" },
    { type: "create", path: "private.txt", content: "hidden" },
  ]);
  const response = (
    await f.dispatch("workspace.diff", {
      from_revision: 0,
      to_revision: 1,
    })
  ).response as { diff: string };
  expect(response.diff).toContain("public.txt");
  expect(response.diff).not.toContain("private.txt");
  expect(response.diff).not.toContain("hidden");
  const emptyPaths = (
    await f.dispatch("workspace.diff", {
      from_revision: 0,
      to_revision: 1,
      paths: [],
    })
  ).response as { diff: string };
  expect(emptyPaths.diff).toEqual(response.diff);
});

it("caps diff output and lets paths narrow it", async () => {
  const f = await fixture();
  await f.apply(
    ["one", "two", "three"].map((path) => ({
      type: "create" as const,
      path,
      content: "a\n".repeat(900_000),
    })),
  );
  await expect(
    f.dispatch("workspace.diff", { from_revision: 0, to_revision: 1 }),
  ).rejects.toMatchObject({
    code: "VALIDATION",
    details: { reason: "diff_too_large", limit: 5 * 1024 * 1024 },
  });
  await expect(
    f.dispatch("workspace.diff", { from_revision: 0, to_revision: 1, paths: ["one", "two"] }),
  ).rejects.toMatchObject({ code: "VALIDATION", details: { reason: "diff_too_large" } });
  expect(
    (
      await f.dispatch("workspace.diff", {
        from_revision: 0,
        to_revision: 1,
        paths: ["one"],
      })
    ).response,
  ).toMatchObject({ diff: expect.stringContaining("+a\n") });
  // Three 1.8 MB files diffed three times: about 2 s alone, over 5 s on a busy CI runner.
}, 20_000);

it("validates ranges, revisions, paths, pagination and path authorization", async () => {
  const f = await fixture();
  for (const params of [
    { from_revision: 1, to_revision: 0 },
    { from_revision: -1, to_revision: 0 },
    { from_revision: 0, to_revision: 0, paths: ["../x"] },
  ])
    await expect(f.dispatch("workspace.diff", params)).rejects.toMatchObject({
      code: "VALIDATION",
    });
  for (const params of [
    { from_revision: 0, to_revision: 1 },
    { from_revision: 1, to_revision: 1 },
  ])
    await expect(f.dispatch("workspace.diff", params)).rejects.toMatchObject({ code: "NOT_FOUND" });
  for (const params of [{ limit: 201 }, { limit: 0 }, { before: -1 }, { path: "../x" }])
    await expect(f.dispatch("workspace.history", params)).rejects.toMatchObject({
      code: "VALIDATION",
    });
  const denied = await fixture(async (_principal, _action, resource) => {
    if (resource?.path === "private") throw new CrossoverError("FORBIDDEN", "Denied");
  });
  await expect(
    denied.dispatch("workspace.diff", { from_revision: 0, to_revision: 0, paths: ["private"] }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(denied.dispatch("workspace.history", { path: "private" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
