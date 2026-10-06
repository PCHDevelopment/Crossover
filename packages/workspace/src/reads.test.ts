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
  const root = await mkdtemp(join(tmpdir(), "crossover-read-test-"));
  dirs.push(root);
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1,$1,'Room','Ship','actor')",
    [room],
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
    participant_id: "actor",
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
  return { room, workspace, repo, options, dispatch, apply };
}

it("reads old contents and file revisions after later modification/deletion, independent of cached refs", async () => {
  const f = await fixture();
  const initial = (await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim();
  await f.apply([{ type: "create", path: "file", content: "old" }]);
  await f.apply([{ type: "modify", path: "file", content: "new" }], 1);
  await f.apply([{ type: "delete", path: "file" }], 2);
  await git(["update-ref", "refs/room/canonical", initial], f.options);
  for (const [revision, content] of [
    [1, "old"],
    [2, "new"],
  ] as const) {
    const result = await f.dispatch("workspace.read", { path: "file", revision });
    expect(result.response).toEqual({
      content,
      encoding: "utf8",
      file_revision: revision,
      workspace_revision: revision,
    });
    expect(result.events).toEqual([]);
  }
  await expect(f.dispatch("workspace.read", { path: "file" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect((await f.dispatch("workspace.list", {})).response).toEqual({
    workspace_revision: 3,
    entries: [],
  });
  expect(
    (await db.pool.query("SELECT count(*) FROM events WHERE room_id = $1", [f.room])).rows[0].count,
  ).toBe("3");
});

it("lists only sorted direct children, preserving full literal room paths and historical metadata", async () => {
  const f = await fixture();
  await f.apply(
    ["z", "dir[1]/a", "dir[1]/nested/b", "tab\tname", "line\nname"].map((path) => ({
      type: "create",
      path,
      content: path,
    })),
  );
  const root = await f.dispatch("workspace.list", { revision: 1 });
  expect(root.response).toEqual({
    workspace_revision: 1,
    entries: [
      { path: "dir[1]", type: "directory" },
      { path: "line\nname", type: "file", file_revision: 1, size: 9 },
      { path: "tab\tname", type: "file", file_revision: 1, size: 8 },
      { path: "z", type: "file", file_revision: 1, size: 1 },
    ],
  });
  expect((await f.dispatch("workspace.list", { path: "./dir[1]/" })).response).toEqual({
    workspace_revision: 1,
    entries: [
      { path: "dir[1]/a", type: "file", file_revision: 1, size: 8 },
      { path: "dir[1]/nested", type: "directory" },
    ],
  });
  expect((await f.dispatch("workspace.read", { path: "dir[1]/a" })).response).toMatchObject({
    content: "dir[1]/a",
  });
  expect(JSON.stringify(root.response)).not.toMatch(/[a-f0-9]{40}/);
});

it("returns binary and large text bytes as base64", async () => {
  const f = await fixture();
  for (const [path, content] of [
    ["binary", "one\0two"],
    ["large", "é".repeat(3 * 1024 * 1024)],
  ]) {
    await f.apply(
      [
        {
          type: "create",
          path: path!,
          content: path === "binary" ? Buffer.from(content!).toString("base64") : content!,
          encoding: path === "binary" ? "base64" : "utf8",
        },
      ],
      path === "binary" ? 0 : 1,
    );
    const result = await f.dispatch("workspace.read", { path });
    expect(result.response).toMatchObject({
      content: Buffer.from(content!).toString("base64"),
      encoding: "base64",
      file_revision: 1,
    });
  }
});

it("distinguishes symlinks/submodules and reads link targets without following them", async () => {
  const f = await fixture();
  const initial = (await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim();
  const blob = (
    await git(["hash-object", "-w", "--stdin"], { ...f.options, input: "../../outside" })
  ).stdout.trim();
  const largeSize = 25 * 1024 * 1024 + 1;
  const large = (
    await git(["hash-object", "-w", "--stdin"], {
      ...f.options,
      input: Buffer.alloc(largeSize, 120),
    })
  ).stdout.trim();
  const tree = (
    await git(["mktree", "-z"], {
      ...f.options,
      input:
        `120000 blob ${blob}\tlink\0` +
        `160000 commit ${initial}\tmodule\0` +
        `100644 blob ${large}\thuge\0`,
    })
  ).stdout.trim();
  const commit = (
    await git(["commit-tree", tree, "-p", initial], {
      ...f.options,
      input: "Import\n",
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
    })
  ).stdout.trim();
  await db.pool.query(
    "INSERT INTO workspace_revisions (workspace_id,room_id,revision,commit_sha) VALUES ($1,$2,1,$3)",
    [f.workspace, f.room, commit],
  );
  await db.pool.query(
    "INSERT INTO file_revisions (workspace_id,room_id,path,revision,workspace_revision,blob_sha,actor_id) VALUES ($1,$2,'link',1,1,$3,'actor')",
    [f.workspace, f.room, blob],
  );
  expect((await f.dispatch("workspace.list", {})).response).toMatchObject({
    entries: [
      { path: "huge", type: "file", file_revision: 0, size: largeSize },
      { path: "link", type: "symlink", file_revision: 1 },
      { path: "module", type: "submodule" },
    ],
  });
  expect((await f.dispatch("workspace.read", { path: "link" })).response).toMatchObject({
    content: "../../outside",
    encoding: "utf8",
  });
  await expect(f.dispatch("workspace.read", { path: "module" })).rejects.toMatchObject({
    code: "VALIDATION",
    details: { reason: "not_a_file" },
  });
  await expect(f.dispatch("workspace.read", { path: "huge" })).rejects.toMatchObject({
    code: "VALIDATION",
    details: { reason: "file_too_large", size: largeSize, limit: 25 * 1024 * 1024 },
  });
});

it("returns typed missing-path/revision/invalid-path errors and enforces path authorization", async () => {
  const f = await fixture(async (_principal, action, resource) => {
    if (action === "workspace.read" && resource.path === "denied")
      throw new CrossoverError("FORBIDDEN", "Denied");
  });
  await f.apply([{ type: "create", path: "file", content: "x" }]);
  for (const params of [{ path: "missing" }, { path: "file", revision: 99 }]) {
    await expect(f.dispatch("workspace.read", params)).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  await expect(f.dispatch("workspace.read", { path: "../file" })).rejects.toMatchObject({
    code: "VALIDATION",
  });
  await expect(f.dispatch("workspace.list", { path: "file" })).rejects.toMatchObject({
    code: "VALIDATION",
  });
  await expect(f.dispatch("workspace.read", { path: "denied" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
