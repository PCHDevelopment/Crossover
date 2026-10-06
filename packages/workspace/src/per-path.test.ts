import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { Dispatcher, type Authorizer } from "@crossover/kernel";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerWorkspaceCommands, type WorkspaceCommandDeps } from "./apply.js";
import { provisionWorkspace } from "./provision.js";
import { merge as mergeWorkspace } from "./merge.js";
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

type Who = Parameters<Dispatcher["dispatch"]>[0];

/** A room with a real policy: an owner, plus a reviewer who may only write under docs/. */
async function fixture(deps: WorkspaceCommandDeps = {}) {
  const room = newId("room");
  const root = await mkdtemp(join(tmpdir(), "crossover-perpath-test-"));
  dirs.push(root);
  const ownerId = newId("part");
  const reviewerId = newId("part");
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1,$1,'Room','Ship',$2)",
    [room, ownerId],
  );
  await db.pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status) VALUES
       ($1, $3, 'HUMAN', 'owner', 'OWNER', 'LEAD', 'ACTIVE'),
       ($2, $3, 'AGENT', 'reviewer', 'MEMBER', 'REVIEWER', 'ACTIVE')`,
    [ownerId, reviewerId, room],
  );
  await db.pool.query(
    `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, created_by, created_at)
     VALUES ($1, $2, $3, 'GRANT', 'workspace.write:docs/**', $4, clock_timestamp())`,
    [newId("grant"), room, reviewerId, ownerId],
  );
  await db.pool.query(
    `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, created_by, created_at) VALUES
       ($1, $2, $3, 'DENY', 'workspace.read:secrets/**', $4, clock_timestamp()),
       ($5, $2, $3, 'DENY', 'workspace.write:secrets/**', $4, clock_timestamp()),
       ($6, $2, $3, 'DENY', 'workspace.read:vault/hidden/**', $4, clock_timestamp())`,
    [newId("grant"), room, reviewerId, ownerId, newId("grant"), newId("grant")],
  );
  await withTransaction(db.pool, (client) => provisionWorkspace(client, room, root));

  const gates: { method: string; perPath: boolean | undefined }[] = [];
  const recording: Authorizer = async (principal, action, resource, context) => {
    if (resource.path === undefined)
      gates.push({ method: context.method, perPath: context.perPath });
    return authorize(principal, action, resource, context);
  };
  const dispatcher = new Dispatcher({ pool: db.pool, authorize: recording, nodeId: room });
  registerWorkspaceCommands(dispatcher, deps);

  const owner: Who = {
    room_id: room,
    participant_id: ownerId,
    kind: "HUMAN",
    authority: "OWNER",
    role: "LEAD",
  };
  const reviewer: Who = {
    room_id: room,
    participant_id: reviewerId,
    kind: "AGENT",
    authority: "MEMBER",
    role: "REVIEWER",
  };
  const apply = (who: Who, operations: Operation[], base: number) =>
    dispatcher.dispatch(who, {
      id: newId("cmd"),
      method: "workspace.apply_changeset",
      params: { source: "API", message: "Edit", base_workspace_revision: base, operations },
      idempotency_key: newId("cmd"),
    });
  const revision = async () =>
    Number(
      (
        await db.pool.query(
          "SELECT max(revision) AS revision FROM workspace_revisions WHERE room_id = $1",
          [room],
        )
      ).rows[0].revision,
    );
  return { dispatcher, owner, reviewer, apply, revision, gates };
}

it("a reviewer with workspace.write:docs/** applies a ChangeSet touching docs/ only", async () => {
  const f = await fixture();
  await f.apply(f.owner, [{ type: "create", path: "src/a.ts", content: "a" }], 0);
  const ok = await f.apply(f.reviewer, [{ type: "create", path: "docs/b.md", content: "b" }], 1);
  expect(ok.events.map((e) => e.type)).toContain("workspace.changeset.applied");
  expect(await f.revision()).toBe(2);

  for (const operations of [
    [{ type: "create", path: "src/c.ts", content: "c" }],
    [{ type: "modify", path: "src/a.ts", content: "changed" }],
    [
      { type: "create", path: "docs/d.md", content: "d" },
      { type: "create", path: "src/e.ts", content: "e" },
    ],
  ] as Operation[][]) {
    const err = await f.apply(f.reviewer, operations, 2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossoverError);
    expect((err as CrossoverError).code).toBe("FORBIDDEN");
  }
  expect(await f.revision()).toBe(2); // nothing was applied
});

it("declares per-path authorization on the commands that authorize every path, and only those", async () => {
  const f = await fixture();
  await f.apply(f.owner, [{ type: "create", path: "a.txt", content: "x" }], 0);
  f.gates.length = 0;
  for (const [method, params] of [
    ["workspace.read", { path: "a.txt" }],
    ["workspace.blame", { path: "a.txt" }],
    ["workspace.search", { query: "x" }],
    ["workspace.list", {}],
    ["workspace.history", {}],
  ] as const) {
    await f.dispatcher.dispatch(f.owner, { id: newId("cmd"), method, params });
  }
  expect(f.gates).toEqual([
    { method: "workspace.read", perPath: true },
    { method: "workspace.blame", perPath: true },
    { method: "workspace.search", perPath: true },
    { method: "workspace.list", perPath: true },
    { method: "workspace.history", perPath: true },
  ]);
});

it("hides denied paths from listings, diff, and unfiltered history under real policy", async () => {
  const f = await fixture();
  await f.apply(
    f.owner,
    [
      { type: "create", path: "docs/readable.txt", content: "visible" },
      { type: "create", path: "secrets/hidden.txt", content: "hidden" },
      { type: "create", path: "vault/open.txt", content: "visible" },
      { type: "create", path: "vault/hidden/private.txt", content: "hidden" },
    ],
    0,
  );
  const listing = await f.dispatcher.dispatch(f.reviewer, {
    id: newId("cmd"),
    method: "workspace.list",
    params: {},
  });
  expect(listing.response).toMatchObject({
    entries: [
      { path: "docs", type: "directory" },
      { path: "vault", type: "directory" },
    ],
  });
  expect(JSON.stringify(listing.response)).not.toContain("secrets");
  expect(JSON.stringify(listing.response)).toContain("vault");
  const vault = await f.dispatcher.dispatch(f.reviewer, {
    id: newId("cmd"),
    method: "workspace.list",
    params: { path: "vault" },
  });
  expect(vault.response).toMatchObject({ entries: [{ path: "vault/open.txt" }] });
  expect(JSON.stringify(vault.response)).not.toContain("private.txt");
  await expect(
    f.dispatcher.dispatch(f.reviewer, {
      id: newId("cmd"),
      method: "workspace.list",
      params: { path: "secrets" },
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  const diff = await f.dispatcher.dispatch(f.reviewer, {
    id: newId("cmd"),
    method: "workspace.diff",
    params: { from_revision: 0, to_revision: 1 },
  });
  expect(JSON.stringify(diff.response)).toContain("readable.txt");
  expect(JSON.stringify(diff.response)).not.toContain("secrets");
  expect(JSON.stringify(diff.response)).not.toContain("hidden");

  const history = await f.dispatcher.dispatch(f.reviewer, {
    id: newId("cmd"),
    method: "workspace.history",
    params: {},
  });
  expect(history.response).toMatchObject({ entries: [{ workspace_revision: 0 }] });
  expect(JSON.stringify(history.response)).not.toContain("hidden");
});

it("redacts unauthorized conflict paths and content", async () => {
  let mergeCalls = 0;
  const f = await fixture({
    merge: async (...args) => {
      if (mergeCalls++ === 0) return mergeWorkspace(...args);
      return {
        clean: false,
        tree: "",
        conflicts: {
          files: [{ path: "secrets/file.txt", stages: [] }],
          messages: [
            {
              paths: ["secrets/file.txt"],
              type: "CONFLICT (directory rename)",
              message: "private conflicting content",
            },
          ],
        },
      };
    },
  });
  await f.apply(f.owner, [{ type: "create", path: "docs/file.txt", content: "base" }], 0);
  const conflict = await f.apply(
    f.reviewer,
    [{ type: "modify", path: "docs/file.txt", content: "private conflicting content" }],
    1,
  );
  expect(conflict.response).toMatchObject({ status: "CONFLICT" });
  expect(JSON.stringify(conflict.response)).not.toContain("secrets/file.txt");
  expect(JSON.stringify(conflict.response)).not.toContain("private conflicting content");
  expect(conflict.response).toMatchObject({
    conflicts: [{ path: null, reason: "unauthorized" }],
  });
});
