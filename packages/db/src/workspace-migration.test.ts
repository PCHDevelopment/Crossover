import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./testing.js";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.pool.query(`
    INSERT INTO rooms (id, slug, name, objective, owner_id)
    VALUES ('room_ws1', 'ws1', 'Workspace 1', 'Ship', 'actor_1'),
           ('room_ws2', 'ws2', 'Workspace 2', 'Ship', 'actor_2');
    INSERT INTO workspaces (id, room_id, repo_path)
    VALUES ('ws_1', 'room_ws1', '/repos/1.git'), ('ws_2', 'room_ws2', '/repos/2.git');
  `);
  for (const workspace of ["ws_1", "ws_2"]) {
    for (const number of [0, 1, 2]) await revision(workspace, number);
  }
  await fileRevision("ws_1", "seed.txt", 1, 0);
});

afterAll(async () => {
  await db?.drop();
});

const revision = (workspace: string, number: number) =>
  db.pool.query(
    `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
     SELECT id, room_id, $2, 'commit' FROM workspaces WHERE id = $1`,
    [workspace, number],
  );

const fileRevision = (workspace: string, path: string, number: number, head: number) =>
  db.pool.query(
    `INSERT INTO file_revisions
     (workspace_id, room_id, path, revision, workspace_revision, blob_sha, actor_id)
     SELECT id, room_id, $2, $3, $4, 'blob', 'actor_1' FROM workspaces WHERE id = $1`,
    [workspace, path, number, head],
  );

const changeset = (id: string, source = "API", status = "PENDING") =>
  db.pool.query(
    `INSERT INTO changesets
     (id, workspace_id, room_id, actor_id, idempotency_key, source, message,
      base_workspace_revision, payload, status)
     VALUES ($1, 'ws_1', 'room_ws1', 'actor_1', 'retry-key', $2, 'Edit file', 0, $3, $4)
     RETURNING *`,
    [
      id,
      source,
      JSON.stringify({ operations: [{ type: "create", path: "new.txt", content: "hi" }] }),
      status,
    ],
  );

describe("0014_workspace", () => {
  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 14");
    expect(rows).toEqual([{ name: "workspace" }]);
  });

  it("makes workspace revisions unique within a workspace", async () => {
    await revision("ws_1", 3);
    await expect(revision("ws_1", 3)).rejects.toMatchObject({ code: "23505" });
    await revision("ws_2", 3);
    await revision("ws_1", 4);
  });

  it("makes file revisions unique per workspace and path", async () => {
    await fileRevision("ws_1", "file.txt", 1, 1);
    await expect(fileRevision("ws_1", "file.txt", 1, 1)).rejects.toMatchObject({ code: "23505" });
    await fileRevision("ws_1", "other.txt", 1, 1);
    await fileRevision("ws_2", "file.txt", 1, 1);
    await fileRevision("ws_1", "file.txt", 2, 2);
  });

  it("allows an initial revision without a ChangeSet and records creation time", async () => {
    const { rows } = await db.pool.query(
      "SELECT changeset_id, created_at FROM workspace_revisions WHERE room_id = $1 AND revision = 0",
      ["room_ws1"],
    );
    expect(rows[0].changeset_id).toBeNull();
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it("enforces one workspace per room and requires an existing room", async () => {
    for (const [room, code] of [
      ["room_ws1", "23505"],
      ["missing", "23503"],
    ]) {
      await expect(
        db.pool.query(
          "INSERT INTO workspaces (id, room_id, repo_path) VALUES ('ws_bad', $1, '/repo')",
          [room],
        ),
      ).rejects.toMatchObject({ code });
    }
  });

  it.each(["workspace_revisions", "file_revisions", "changesets"])(
    "prevents %s from claiming another room",
    async (table) => {
      // Reassign one otherwise valid row; composite FKs must catch the mismatch.
      if (table === "changesets") await changeset("cs_room");
      await expect(
        db.pool.query(`UPDATE ${table} SET room_id = $1 WHERE workspace_id = $2 AND room_id = $3`, [
          "room_ws2",
          "ws_1",
          "room_ws1",
        ]),
      ).rejects.toMatchObject({ code: "23503" });
    },
  );

  it("requires a file revision to reference an existing workspace revision", async () => {
    await expect(fileRevision("ws_1", "missing.txt", 1, 999)).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("stores deletion rows with no blob", async () => {
    await fileRevision("ws_1", "deleted.txt", 1, 1);
    const { rows } = await db.pool.query(
      `UPDATE file_revisions SET blob_sha = NULL
       WHERE room_id = $1 AND path = 'deleted.txt' RETURNING blob_sha`,
      ["room_ws1"],
    );
    expect(rows).toEqual([{ blob_sha: null }]);
  });

  it("rejects negative workspace revisions and nonpositive file revisions", async () => {
    await expect(revision("ws_1", -1)).rejects.toMatchObject({ code: "23514" });
    for (const number of [0, -1]) {
      await expect(fileRevision("ws_1", "bad.txt", number, 0)).rejects.toMatchObject({
        code: "23514",
      });
    }
  });

  it("stores durable operations and §10.1 metadata", async () => {
    const { rows } = await changeset("cs_payload");
    expect(rows[0]).toMatchObject({
      actor_id: "actor_1",
      idempotency_key: "retry-key",
      status: "PENDING",
      source: "API",
      base_workspace_revision: "0",
      base_file_revisions: {},
      task_id: null,
      conflict_id: null,
      applied_revision: null,
      applied_at: null,
      rejection_reason: null,
      payload: { operations: [{ type: "create", path: "new.txt", content: "hi" }] },
    });
    expect(rows[0].created_at).toBeInstanceOf(Date);
    // Deduplication is owned by the command layer, not a second uniqueness rule here.
    await changeset("cs_same_key");
    await db.pool.query(
      `UPDATE changesets SET task_id = 'task_future', conflict_id = 'conflict_future',
       base_file_revisions = $2 WHERE room_id = $1 AND id = 'cs_payload'`,
      ["room_ws1", JSON.stringify({ "file.txt": 2 })],
    );
  });

  it("defaults a submitted ChangeSet to PENDING", async () => {
    const { rows } = await db.pool.query(
      `INSERT INTO changesets
       (id, workspace_id, room_id, actor_id, idempotency_key, source, message,
        base_workspace_revision, payload)
       VALUES ('cs_default', 'ws_1', 'room_ws1', 'actor_1', 'default-key', 'API', 'Empty', 0, '{}')
       RETURNING status`,
    );
    expect(rows).toEqual([{ status: "PENDING" }]);
  });

  it.each(["workspace_revisions", "file_revisions", "changesets"])(
    "requires room_id on %s",
    async (table) => {
      if (table === "changesets") await changeset("cs_null_room");
      await expect(
        db.pool.query(`UPDATE ${table} SET room_id = NULL WHERE room_id = $1`, ["room_ws1"]),
      ).rejects.toMatchObject({ code: "23502" });
    },
  );

  it.each(["EDITOR", "SANDBOX", "API", "UPSTREAM", "RESOLUTION"])(
    "accepts source %s",
    async (source) => {
      await changeset(`cs_source_${source}`, source);
    },
  );

  it.each(["PENDING", "APPLIED", "CONFLICT", "REJECTED"])("accepts status %s", async (status) => {
    await changeset(`cs_status_${status}`, "API", status);
  });

  it("rejects unknown source and status values", async () => {
    await expect(changeset("cs_bad_source", "OTHER")).rejects.toMatchObject({ code: "23514" });
    await expect(changeset("cs_bad_status", "API", "OTHER")).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("links applied revisions to ChangeSets without crossing workspace boundaries", async () => {
    await changeset("cs_applied");
    await db.pool.query(
      `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha, changeset_id)
       VALUES ('ws_1', 'room_ws1', 5, 'applied-commit', 'cs_applied')`,
    );
    await db.pool.query(
      `UPDATE changesets SET applied_revision = 5, status = 'APPLIED', applied_at = now()
       WHERE room_id = 'room_ws1' AND id = 'cs_applied'`,
    );
    await expect(
      db.pool.query(
        `UPDATE changesets SET applied_revision = 999 WHERE room_id = 'room_ws1' AND id = 'cs_applied'`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      db.pool.query(
        `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha, changeset_id)
       VALUES ('ws_2', 'room_ws2', 5, 'wrong-commit', 'cs_applied')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
