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
  const root = await mkdtemp(join(tmpdir(), "crossover-read-test-"));
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
  const dispatchAs = (
    who: typeof principal | Parameters<Dispatcher["dispatch"]>[0],
    method: string,
    params: Record<string, unknown>,
    mutating = false,
  ) =>
    dispatcher.dispatch(who, {
      id: newId("cmd"),
      method,
      params,
      ...(mutating ? { idempotency_key: newId("cmd") } : {}),
    });
  const dispatch = (method: string, params: Record<string, unknown>, mutating = false) =>
    dispatchAs(principal, method, params, mutating);
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
  return {
    room,
    workspace,
    repo,
    options,
    dispatcher,
    principal,
    dispatchAs,
    dispatch,
    apply,
    owner,
  };
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

it("reads submitted candidate content with non-conflicting edits for the review ladder only", async () => {
  const f = await fixture();
  const submitterId = newId("part");
  const reviewerId = newId("part");
  for (const [id, name] of [
    [submitterId, "Submitter"],
    [reviewerId, "Reviewer"],
  ]) {
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, 'HUMAN', $3, 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
      [id, f.room, name],
    );
  }
  const submitter = {
    ...f.principal,
    participant_id: submitterId,
    authority: "MEMBER" as const,
    role: "DEVELOPER" as const,
  };
  const reviewer = { ...submitter, participant_id: reviewerId };

  await f.apply([{ type: "create", path: "docs/review.txt", content: "base\nunchanged\n" }]);
  await f.apply([{ type: "modify", path: "docs/review.txt", content: "head\nunchanged\n" }], 1);
  const result = await f.dispatchAs(
    submitter,
    "workspace.apply_changeset",
    {
      source: "API",
      message: "Candidate with a clean second-line edit",
      base_workspace_revision: 1,
      operations: [{ type: "modify", path: "docs/review.txt", content: "mine\nsubmitted edit\n" }],
    },
    true,
  );
  const changesetId = (result.response as { changeset_id: string }).changeset_id;
  expect(result.response).toMatchObject({ status: "CONFLICT" });

  const metadata = await f.dispatchAs(reviewer, "workspace.changeset.get", {
    changeset_id: changesetId,
  });
  expect(metadata.response).toMatchObject({
    id: changesetId,
    status: "CONFLICT",
    paths: ["docs/review.txt"],
  });
  await expect(
    f.dispatchAs(reviewer, "workspace.changeset.get", {
      changeset_id: changesetId,
      path: "docs/review.txt",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });

  const candidate = await f.dispatchAs(submitter, "workspace.changeset.get", {
    changeset_id: changesetId,
    path: "docs/review.txt",
  });
  expect(candidate.response).toMatchObject({
    path: "docs/review.txt",
    content: "mine\nsubmitted edit\n",
    encoding: "utf8",
  });
});

it("redacts unreadable touched paths and returns applied contents at that revision", async () => {
  const readerId = newId("part");
  const f = await fixture(async (principal, action, resource, context) => {
    if (
      principal.participant_id === readerId &&
      action === "workspace.read" &&
      resource.path === "secrets/private.txt"
    )
      throw new CrossoverError("FORBIDDEN", "Path is not readable");
    return allowAll(principal, action, resource, context);
  });
  await db.pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'Reader', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
    [readerId, f.room],
  );
  const reader = {
    ...f.principal,
    participant_id: readerId,
    authority: "MEMBER" as const,
    role: "DEVELOPER" as const,
  };
  const created = await f.apply([
    { type: "create", path: "secrets/private.txt", content: "private\n" },
    { type: "create", path: "docs/public.txt", content: "public\n" },
  ]);
  const changesetId = (created.response as { changeset_id: string }).changeset_id;
  const metadata = await f.dispatchAs(reader, "workspace.changeset.get", {
    changeset_id: changesetId,
  });
  expect(metadata.response).toMatchObject({ paths: ["docs/public.txt"] });
  await expect(
    f.dispatchAs(reader, "workspace.changeset.get", {
      changeset_id: changesetId,
      path: "secrets/private.txt",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    f.dispatchAs(reader, "workspace.changeset.get", { changeset_id: "cs_other-room" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  const publicContent = await f.dispatch("workspace.changeset.get", {
    changeset_id: changesetId,
    path: "docs/public.txt",
  });
  expect(publicContent.response).toMatchObject({
    content: "public\n",
    encoding: "utf8",
    applied_revision: 1,
  });
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

it("omits children denied by path scope from directory listings", async () => {
  const f = await fixture(async (_principal, action, resource) => {
    if (action === "workspace.read" && resource.path === "private.txt")
      throw new CrossoverError("FORBIDDEN", "Denied");
  });
  await f.apply([
    { type: "create", path: "public.txt", content: "visible" },
    { type: "create", path: "private.txt", content: "hidden" },
  ]);
  expect((await f.dispatch("workspace.list", {})).response).toMatchObject({
    entries: [{ path: "public.txt", type: "file" }],
  });
});
