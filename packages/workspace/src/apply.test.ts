import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher, type Authorizer } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { git } from "./git.js";
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

async function fixture(authorize: Authorizer = allowAll) {
  const room = newId("room");
  const root = await mkdtemp(join(tmpdir(), "crossover-apply-test-"));
  dirs.push(root);
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Room', 'Ship', 'actor')",
    [room],
  );
  const workspace = await withTransaction(db.pool, (client) =>
    provisionWorkspace(client, room, root),
  );
  const { rows } = await db.pool.query("SELECT repo_path FROM workspaces WHERE room_id = $1", [
    room,
  ]);
  const repo = rows[0].repo_path as string;
  const options = { gitDir: repo, timeoutMs: 10_000 };
  const dispatcher = new Dispatcher({ pool: db.pool, authorize, nodeId: room });
  registerWorkspaceCommands(dispatcher);
  const head = async () => (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
  const request = (operations: Operation[], base = 0, key = newId("cmd")) => ({
    id: newId("cmd"),
    method: "workspace.apply_changeset",
    idempotency_key: key,
    params: { source: "API", message: "Edit", base_workspace_revision: base, operations },
  });
  const dispatch = (input: ReturnType<typeof request>) =>
    dispatcher.dispatch(
      {
        room_id: room,
        participant_id: "actor",
        kind: "HUMAN",
        authority: "MEMBER",
        role: "DEVELOPER",
      },
      input,
    );
  const apply = (operations: Operation[], base = 0) => dispatch(request(operations, base));
  const rowsFor = async (
    table: "changesets" | "workspace_revisions" | "file_revisions" | "events",
  ) => (await db.pool.query(`SELECT * FROM ${table} WHERE room_id = $1`, [room])).rows;
  return { room, workspace, repo, options, head, request, dispatch, apply, rowsFor };
}

describe("workspace.apply_changeset", () => {
  it("commits revision, file history and event together, then replays the original result", async () => {
    const f = await fixture();
    const input = f.request([{ type: "create", path: "file", content: "one" }]);
    const result = await f.dispatch(input);
    expect(result.response).toMatchObject({ status: "APPLIED", applied_revision: 1 });
    expect(result.events).toMatchObject([
      { type: "workspace.changeset.applied", payload: { applied_revision: 1 } },
    ]);
    expect((await f.rowsFor("changesets"))[0]).toMatchObject({
      status: "APPLIED",
      actor_id: "actor",
      idempotency_key: input.idempotency_key,
      applied_revision: "1",
    });
    const revisions = await f.rowsFor("workspace_revisions");
    expect(revisions).toHaveLength(2);
    expect(await f.head()).toBe(revisions.find((r) => r.revision === "1")!.commit_sha);
    expect(await f.rowsFor("file_revisions")).toMatchObject([
      { path: "file", revision: "1", workspace_revision: "1", actor_id: "actor" },
    ]);
    expect(await f.dispatch({ ...input, id: newId("cmd") })).toEqual({ ...result, replayed: true });
    expect(await f.rowsFor("changesets")).toHaveLength(1);
    expect(await f.rowsFor("events")).toHaveLength(1);
  });

  it("persists conflict data and its event while applying none of the operations", async () => {
    const f = await fixture();
    await f.apply([{ type: "create", path: "file", content: "old\n" }]);
    await f.apply([{ type: "modify", path: "file", content: "head\n" }], 1);
    const head = await f.head();
    const input = f.request(
      [
        { type: "modify", path: "file", content: "candidate\n" },
        { type: "create", path: "otherwise-clean", content: "x" },
      ],
      1,
    );
    const result = await f.dispatch(input);
    expect(result.response).toMatchObject({
      status: "CONFLICT",
      conflicts: [{ path: "file", kind: "CONTENT" }],
    });
    expect(result.events).toMatchObject([
      { type: "workspace.conflict.created", payload: { files: [{ path: "file" }] } },
    ]);
    expect(
      (await f.rowsFor("changesets")).find((row) => row.status === "CONFLICT")?.payload.conflicts,
    ).toMatchObject([{ path: "file", kind: "CONTENT" }]);
    expect(await f.rowsFor("workspace_revisions")).toHaveLength(3);
    expect((await f.rowsFor("file_revisions")).some((row) => row.path === "otherwise-clean")).toBe(
      false,
    );
    expect(await f.head()).toBe(head);
    expect(await f.dispatch({ ...input, id: newId("cmd") })).toEqual({ ...result, replayed: true });
    expect(await f.rowsFor("events")).toHaveLength(3);
  });

  it("records rename/deletion history and per-path revisions", async () => {
    const f = await fixture();
    await f.apply([{ type: "create", path: "old", content: "one" }]);
    await f.apply([{ type: "modify", path: "old", content: "two" }], 1);
    await f.apply([{ type: "rename", from: "old", to: "new" }], 2);
    const rows = await f.rowsFor("file_revisions");
    expect(
      rows
        .filter((row) => row.path === "old")
        .map((row) => row.revision)
        .sort(),
    ).toEqual(["1", "2", "3"]);
    expect(rows.find((row) => row.path === "old" && row.revision === "3")?.blob_sha).toBeNull();
    expect(rows.find((row) => row.path === "new")).toMatchObject({
      revision: "1",
      workspace_revision: "3",
    });
  });

  it("authorizes both normalized rename paths and rolls back a denial", async () => {
    const paths: string[] = [];
    const f = await fixture(async (_principal, _action, resource) => {
      if (resource.path) paths.push(resource.path as string);
      if (resource.path === "denied") throw new CrossoverError("FORBIDDEN", "Denied path");
    });
    await f.apply([{ type: "create", path: "old", content: "x" }]);
    const head = await f.head();
    await expect(
      f.apply([{ type: "rename", from: "./old", to: "./denied" }], 1),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(paths).toEqual(["old", "old", "denied"]);
    expect(await f.rowsFor("changesets")).toHaveLength(1);
    // The first apply's event, plus the denial (T215), but nothing from the denied apply.
    expect((await f.rowsFor("events")).map((e) => e.type)).toEqual([
      "workspace.changeset.applied",
      "capability.denied",
    ]);
    expect(await f.head()).toBe(head);
  });

  it("rolls back pending payload on validation failure", async () => {
    const f = await fixture();
    const head = await f.head();
    await expect(f.apply([{ type: "delete", path: "missing" }])).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(await f.rowsFor("changesets")).toEqual([]);
    expect(await f.rowsFor("file_revisions")).toEqual([]);
    expect(await f.rowsFor("events")).toEqual([]);
    expect(await f.head()).toBe(head);
  });

  it("returns VALIDATION for either ChangeSet limit before persisting state or events", async () => {
    const f = await fixture();
    const head = await f.head();
    for (const operations of [
      Array.from({ length: 501 }, (_, index) => ({
        type: "create" as const,
        path: `file${index}`,
        content: "x",
      })),
      [{ type: "create" as const, path: "large", content: "x".repeat(25 * 1024 * 1024 + 1) }],
    ])
      await expect(f.apply(operations)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await f.rowsFor("changesets")).toEqual([]);
    expect(await f.rowsFor("file_revisions")).toEqual([]);
    expect(await f.rowsFor("events")).toEqual([]);
    expect(await f.rowsFor("workspace_revisions")).toHaveLength(1);
    expect(await f.head()).toBe(head);
  });

  it("authorizes an implicit destination when Git carries a stale edit through a head rename", async () => {
    let deny = false;
    const f = await fixture(async (_principal, _action, resource) => {
      if (deny && resource.path === "denied")
        throw new CrossoverError("FORBIDDEN", "Denied destination");
    });
    await f.apply([{ type: "create", path: "old", content: "one\ntwo\nthree\n" }]);
    await f.apply([{ type: "rename", from: "old", to: "denied" }], 1);
    const head = await f.head();
    deny = true;
    await expect(
      f.apply([{ type: "modify", path: "old", content: "one\nEDIT\nthree\n" }], 1),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await f.rowsFor("changesets")).toHaveLength(2);
    expect(await f.head()).toBe(head);
  });

  it("serializes racing applications from the same base and preserves both edits", async () => {
    const f = await fixture();
    const results = await Promise.all(
      ["one", "two"].map((path) => f.apply([{ type: "create", path, content: path }])),
    );
    expect(
      results.map((r) => (r.response as { applied_revision: number }).applied_revision),
    ).toEqual([1, 2]);
    const head = await f.head();
    for (const path of ["one", "two"])
      expect((await git(["show", `${head}:${path}`], f.options)).stdout).toBe(path);
    expect(await f.rowsFor("workspace_revisions")).toHaveLength(3);
    expect(await f.rowsFor("events")).toHaveLength(2);
  });

  it("keeps canonical unchanged when event append fails after writing Git objects and state", async () => {
    const f = await fixture();
    const head = await f.head();
    await db.pool.query(
      "ALTER TABLE events ADD CONSTRAINT reject_apply CHECK (type <> 'workspace.changeset.applied') NOT VALID",
    );
    try {
      await expect(f.apply([{ type: "create", path: "file", content: "x" }])).rejects.toThrow();
      expect(await f.rowsFor("changesets")).toEqual([]);
      expect(await f.rowsFor("workspace_revisions")).toHaveLength(1);
      expect(await f.rowsFor("file_revisions")).toEqual([]);
      expect(await f.rowsFor("events")).toEqual([]);
      expect(await f.head()).toBe(head);
    } finally {
      await db.pool.query("ALTER TABLE events DROP CONSTRAINT reject_apply");
    }
  });
});
