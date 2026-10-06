import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { isId, newId } from "@crossover/protocol";
import { afterAll, beforeAll, expect, it } from "vitest";
import { git } from "./git.js";
import { provisionWorkspace } from "./provision.js";

let db: TestDatabase;
let root: string;
beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-provision-test-"));
});
afterAll(async () => {
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

it("serializes racing provisioning and preserves the existing workspace on retry", async () => {
  const room = newId("room");
  await db.pool.query(
    "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'Room', 'Ship', 'actor')",
    [room],
  );
  const provision = () =>
    withTransaction(db.pool, (client) => provisionWorkspace(client, room, root));
  const ids = await Promise.all([provision(), provision()]);
  expect(ids[0]).toBe(ids[1]);
  expect(isId(ids[0], "ws")).toBe(true);
  const { rows } = await db.pool.query(
    `SELECT w.repo_path, r.commit_sha FROM workspaces w JOIN workspace_revisions r
     ON r.workspace_id = w.id AND r.room_id = w.room_id WHERE w.room_id = $1 AND r.revision = 0`,
    [room],
  );
  expect(rows).toHaveLength(1);
  expect(
    (
      await git(["rev-parse", "refs/room/canonical"], {
        gitDir: rows[0].repo_path,
        timeoutMs: 5000,
      })
    ).stdout.trim(),
  ).toBe(rows[0].commit_sha);
  expect(
    await withTransaction(db.pool, (client) =>
      provisionWorkspace(client, room, join(root, "other-root")),
    ),
  ).toBe(ids[0]);
});
it("rejects a missing room", async () => {
  await expect(
    withTransaction(db.pool, (client) => provisionWorkspace(client, "room_missing", root)),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
