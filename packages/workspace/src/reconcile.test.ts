import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { Dispatcher, allowAll } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import { registerWorkspaceCommands } from "./apply.js";
import { git, GitError } from "./git.js";
import { provisionWorkspace } from "./provision.js";
import { materialize } from "./materialize.js";
import { reconcileRef, updateCanonicalRef } from "./reconcile.js";
import { createShallowRoomFixture } from "./shallow-room-test-helper.js";

let db: TestDatabase;
const dirs: string[] = [];
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const room = newId("room");
  const root = await mkdtemp(join(tmpdir(), "crossover-reconcile-test-"));
  dirs.push(root);
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1,$1,'Room','Ship','actor')",
    [room],
  );
  await withTransaction(db.pool, (client) => provisionWorkspace(client, room, root));
  const { rows } = await db.pool.query("SELECT repo_path FROM workspaces WHERE room_id = $1", [
    room,
  ]);
  const repo = rows[0].repo_path as string;
  const options = { gitDir: repo, timeoutMs: 10_000 };
  const ref = async () => (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
  const head = async () =>
    (
      await db.pool.query(
        "SELECT commit_sha FROM workspace_revisions WHERE room_id = $1 ORDER BY revision DESC LIMIT 1",
        [room],
      )
    ).rows[0].commit_sha as string;
  const errors: unknown[] = [];
  const dispatcher = new Dispatcher({
    pool: db.pool,
    authorize: allowAll,
    nodeId: room,
    onAfterCommitError: (error) => errors.push(error),
  });
  let crash = true;
  registerWorkspaceCommands(dispatcher, {
    updateCanonicalRef: async (repo, commit, expected) => {
      // A different connection must see the committed row before any ref mutation.
      expect(await head()).toBe(commit);
      if (crash) throw new Error("Simulated crash after DB commit");
      await updateCanonicalRef(repo, commit, expected);
    },
  });
  const apply = (path: string, base: number) =>
    dispatcher.dispatch(
      {
        participant_id: "actor",
        room_id: room,
        kind: "HUMAN",
        authority: "MEMBER",
        role: "DEVELOPER",
      },
      {
        id: newId("cmd"),
        method: "workspace.apply_changeset",
        idempotency_key: newId("cmd"),
        params: {
          source: "API",
          message: "Create",
          base_workspace_revision: base,
          operations: [{ type: "create", path, content: path }],
        },
      },
    );
  return {
    room,
    repo,
    options,
    ref,
    head,
    errors,
    apply,
    recover: () => {
      crash = false;
    },
  };
}

// Measured (T1529): idle 2921 ms, 3x load 3725 ms; budget 7x.
it("repairs a post-commit crash, rejects jumping a lagging ref, and resumes guarded writes", async () => {
  const f = await fixture();
  const initial = await f.ref();
  expect((await f.apply("one", 0)).response).toMatchObject({
    status: "APPLIED",
    applied_revision: 1,
  });
  expect(await f.ref()).toBe(initial);
  expect(await f.head()).not.toBe(initial);
  expect(f.errors).toHaveLength(1);
  f.recover();
  expect((await f.apply("two", 1)).response).toMatchObject({
    status: "APPLIED",
    applied_revision: 2,
  });
  expect(f.errors[1]).toBeInstanceOf(GitError); // expected revision 1, ref still revision 0
  expect(await f.ref()).toBe(initial);
  const events = (
    await db.pool.query("SELECT sequence FROM events WHERE room_id = $1 ORDER BY sequence", [
      f.room,
    ])
  ).rows;
  expect(events).toEqual([{ sequence: "1" }, { sequence: "2" }]);
  await reconcileRef(db.pool, f.room);
  expect(await f.ref()).toBe(await f.head());
  for (const path of ["one", "two"])
    expect((await git(["show", `${await f.ref()}:${path}`], f.options)).stdout).toBe(path);
  await reconcileRef(db.pool, f.room);
  expect((await f.apply("three", 2)).response).toMatchObject({ applied_revision: 3 });
  expect(await f.ref()).toBe(await f.head());
  expect(f.errors).toHaveLength(2);
}, 30_000);

it("restores a missing canonical ref from revision zero", async () => {
  const f = await fixture();
  await git(["update-ref", "-d", "refs/room/canonical"], f.options);
  await reconcileRef(db.pool, f.room);
  expect(await f.ref()).toBe(await f.head());
});

it("rejects an unprovisioned room", async () => {
  await expect(reconcileRef(db.pool, "room_missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it("replaces an uncommitted Git head with the PostgreSQL-authoritative commit", async () => {
  const f = await fixture();
  const head = await f.head();
  const orphan = await materialize(f.repo, head, [
    { type: "create", path: "orphan", content: "x" },
  ]);
  await updateCanonicalRef(f.repo, orphan, head);
  await reconcileRef(db.pool, f.room);
  expect(await f.ref()).toBe(head);
  expect(
    (await db.pool.query("SELECT revision FROM workspace_revisions WHERE room_id = $1", [f.room]))
      .rows,
  ).toEqual([{ revision: "0" }]);
});

it("repairs the canonical ref while the room retains a shallow upstream boundary", async () => {
  const room = newId("room");
  const root = await mkdtemp(join(tmpdir(), "crossover-reconcile-shallow-"));
  dirs.push(root);
  const shallow = await createShallowRoomFixture(join(root, "fixture"));
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1,$1,'Room','Ship','actor')",
    [room],
  );
  await withTransaction(db.pool, (client) => provisionWorkspace(client, room, root));
  await db.pool.query("UPDATE workspaces SET repo_path = $2 WHERE room_id = $1", [
    room,
    shallow.repository,
  ]);
  await db.pool.query("UPDATE workspace_revisions SET commit_sha = $2 WHERE room_id = $1", [
    room,
    shallow.canonical,
  ]);
  await git(["update-ref", "refs/room/canonical", shallow.initial], {
    gitDir: shallow.repository,
    timeoutMs: 10_000,
  });
  await reconcileRef(db.pool, room);
  expect(
    (
      await git(["rev-parse", "refs/room/canonical"], {
        gitDir: shallow.repository,
        timeoutMs: 10_000,
      })
    ).stdout.trim(),
  ).toBe(shallow.canonical);
  expect(
    (
      await git(["rev-parse", "refs/upstream/head"], {
        gitDir: shallow.repository,
        timeoutMs: 10_000,
      })
    ).stdout.trim(),
  ).toBe(shallow.tip);
});
