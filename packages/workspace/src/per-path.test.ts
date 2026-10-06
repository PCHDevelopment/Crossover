import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { Dispatcher, type Authorizer } from "@crossover/kernel";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerWorkspaceCommands } from "./apply.js";
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

type Who = Parameters<Dispatcher["dispatch"]>[0];

/** A room with a real policy: an owner, plus a reviewer who may only write under docs/. */
async function fixture() {
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
  await withTransaction(db.pool, (client) => provisionWorkspace(client, room, root));

  const gates: { method: string; perPath: boolean | undefined }[] = [];
  const recording: Authorizer = async (principal, action, resource, context) => {
    if (resource.path === undefined)
      gates.push({ method: context.method, perPath: context.perPath });
    return authorize(principal, action, resource, context);
  };
  const dispatcher = new Dispatcher({ pool: db.pool, authorize: recording, nodeId: room });
  registerWorkspaceCommands(dispatcher);

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
    { method: "workspace.list", perPath: undefined },
    { method: "workspace.history", perPath: undefined },
  ]);
});
