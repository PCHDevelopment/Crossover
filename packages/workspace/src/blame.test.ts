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
  const root = await mkdtemp(join(tmpdir(), "crossover-blame-test-"));
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
  const dispatch = (
    method: string,
    params: Record<string, unknown>,
    mutating = false,
    actor: string = owner,
  ) =>
    dispatcher.dispatch(
      { ...principal, participant_id: actor },
      {
        id: newId("cmd"),
        method,
        params,
        ...(mutating ? { idempotency_key: newId("cmd") } : {}),
      },
    );
  const apply = (operations: Operation[], base = 0, actor: string = owner) =>
    dispatch(
      "workspace.apply_changeset",
      {
        source: "API",
        message: "Edit",
        base_workspace_revision: base,
        operations,
      },
      true,
      actor,
    );
  return { room, workspace, repo, options, dispatch, apply, owner };
}

// Measured (T1529): idle n/a, 3x load 4244 ms; budget 7x.
it("attributes edits by two actors, merges adjacent ranges, and reads history despite stale refs", async () => {
  const f = await fixture();
  await f.apply([{ type: "create", path: "file[1]", content: "one\ntwo\nthree\nfour\n" }]);
  await f.apply(
    [{ type: "modify", path: "file[1]", content: "one\nchanged\nupdated\nfour\n" }],
    1,
    "second",
  );
  await f.apply([{ type: "rename", from: "file[1]", to: "renamed" }], 2, "renamer");
  const head = (await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim();
  await git(["update-ref", "refs/room/canonical", `${head}~3`], f.options);
  const result = await f.dispatch("workspace.blame", { path: "renamed" });
  expect(result.events).toEqual([]);
  expect(result.response).toEqual({
    workspace_revision: 3,
    line_count: 4,
    ranges: [
      { start: 1, end: 2, workspace_revision: 1, actor_id: f.owner },
      { start: 2, end: 4, workspace_revision: 2, actor_id: "second" },
      { start: 4, end: 5, workspace_revision: 1, actor_id: f.owner },
    ],
  });
  expect(JSON.stringify(result.response)).not.toMatch(/\b[0-9a-f]{40}\b/);
  expect((await f.dispatch("workspace.blame", { path: "file[1]", revision: 1 })).response).toEqual({
    workspace_revision: 1,
    line_count: 4,
    ranges: [{ start: 1, end: 5, workspace_revision: 1, actor_id: f.owner }],
  });
  await expect(f.dispatch("workspace.blame", { path: "file[1]" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
}, 30_000);

// Measured (T1529): idle n/a, 3x load 2255 ms; budget 7x.
it("counts empty, blank, CRLF and unterminated lines, including unusual path names", async () => {
  const f = await fixture();
  const files = [
    { path: "empty", content: "", count: 0 },
    { path: "blank", content: "\n\n", count: 2 },
    { path: "tab\tline\n", content: "one\r\ntwo", count: 2 },
  ];
  await f.apply(files.map(({ path, content }) => ({ type: "create", path, content })));
  for (const file of files) {
    expect((await f.dispatch("workspace.blame", { path: file.path })).response).toEqual({
      workspace_revision: 1,
      line_count: file.count,
      ranges: file.count
        ? [{ start: 1, end: file.count + 1, workspace_revision: 1, actor_id: f.owner }]
        : [],
    });
  }
}, 20_000);

// Measured (T1529): idle n/a, 3x load 2404 ms; budget 7x.
it("maps imported ancestry to revision zero without leaking Git authors or object IDs", async () => {
  const f = await fixture();
  const { materialize } = await import("./materialize.js");
  const initial = (await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim();
  const imported = await materialize(f.repo, initial, [
    { type: "create", path: "file", content: "imported\nold\n" },
  ]);
  await db.pool.query(
    `UPDATE workspace_revisions SET commit_sha = $3
    WHERE room_id = $1 AND workspace_id = $2 AND revision = 0`,
    [f.room, f.workspace, imported],
  );
  await git(["update-ref", "refs/room/canonical", imported], f.options);
  await f.apply([{ type: "modify", path: "file", content: "imported\nnew\n" }]);
  expect((await f.dispatch("workspace.blame", { path: "file" })).response).toEqual({
    workspace_revision: 1,
    line_count: 2,
    ranges: [
      { start: 1, end: 2, workspace_revision: 0, actor_id: null },
      { start: 2, end: 3, workspace_revision: 1, actor_id: f.owner },
    ],
  });
  const other = await fixture();
  await expect(other.dispatch("workspace.blame", { path: "file" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
}, 20_000);

// Measured (T1529): idle 1549 ms, 3x load 3428 ms; budget 7x.
it("rejects unsupported files before blaming, plus invalid inputs and denied paths", async () => {
  const f = await fixture();
  await f.apply([
    { type: "create", path: "binary", content: "AAEC", encoding: "base64" },
    { type: "create", path: "invalid-utf8", content: "/w==", encoding: "base64" },
    { type: "create", path: "large", content: "x".repeat(5 * 1024 * 1024 + 1) },
    { type: "create", path: "dir/file", content: "text" },
  ]);
  for (const path of ["binary", "invalid-utf8", "large"])
    await expect(f.dispatch("workspace.blame", { path })).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "blame_not_supported" },
    });
  await expect(f.dispatch("workspace.blame", { path: "dir" })).rejects.toMatchObject({
    code: "VALIDATION",
    details: { reason: "not_a_file" },
  });
  for (const params of [{ path: "missing" }, { path: "binary", revision: 99 }])
    await expect(f.dispatch("workspace.blame", params)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  for (const params of [{ path: "../file" }, { path: "binary", revision: -1 }])
    await expect(f.dispatch("workspace.blame", params)).rejects.toMatchObject({
      code: "VALIDATION",
    });
  const denied = await fixture(async (_principal, _action, resource) => {
    if (resource?.path === "private") throw new CrossoverError("FORBIDDEN", "Denied");
  });
  await expect(denied.dispatch("workspace.blame", { path: "private" })).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
}, 25_000);

it("rejects imported symlinks and submodules without following their targets", async () => {
  const f = await fixture();
  const initial = (await git(["rev-parse", "refs/room/canonical"], f.options)).stdout.trim();
  const blob = (
    await git(["hash-object", "-w", "--stdin"], {
      ...f.options,
      input: "../../outside",
    })
  ).stdout.trim();
  const tree = (
    await git(["mktree", "-z"], {
      ...f.options,
      input: `120000 blob ${blob}\tlink\0` + `160000 commit ${initial}\tmodule\0`,
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
    `INSERT INTO workspace_revisions (workspace_id,room_id,revision,commit_sha)
    VALUES ($1,$2,1,$3)`,
    [f.workspace, f.room, commit],
  );
  for (const path of ["link", "module"])
    await expect(f.dispatch("workspace.blame", { path })).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "not_a_file" },
    });
});
