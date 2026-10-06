import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./testing.js";

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase(); // applies every migration in packages/db/migrations
});

afterAll(async () => {
  await db.drop();
});

describe("0001_rooms", () => {
  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 1");
    expect(rows).toEqual([{ name: "rooms" }]);
  });

  it("applies defaults for status, settings, last_sequence and created_at", async () => {
    const { rows } = await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id)
       VALUES ('room_a', 'a', 'A', 'Ship it', 'part_1') RETURNING *`,
    );
    expect(rows[0]).toMatchObject({
      status: "ACTIVE",
      settings: {},
      last_sequence: "0", // bigint comes back as a string
      lead_participant_id: null,
      archived_at: null,
    });
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it.each(["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"])("accepts status %s", async (status) => {
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id, status)
       VALUES ($1, $1, 'n', 'o', 'part_1', $2)`,
      [`room_ok_${status}`, status],
    );
  });

  it("rejects an invalid status in the database", async () => {
    await expect(
      db.pool.query(
        `INSERT INTO rooms (id, slug, name, objective, owner_id, status)
         VALUES ('room_bad', 'bad', 'n', 'o', 'part_1', 'FROZEN')`,
      ),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });

  it("rejects a status in the wrong case", async () => {
    await expect(
      db.pool.query(
        `INSERT INTO rooms (id, slug, name, objective, owner_id, status)
         VALUES ('room_lc', 'lc', 'n', 'o', 'part_1', 'active')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces unique slugs and primary keys", async () => {
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id)
       VALUES ('room_u1', 'unique-slug', 'n', 'o', 'part_1')`,
    );
    await expect(
      db.pool.query(
        `INSERT INTO rooms (id, slug, name, objective, owner_id)
         VALUES ('room_u2', 'unique-slug', 'n', 'o', 'part_1')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.pool.query(
        `INSERT INTO rooms (id, slug, name, objective, owner_id)
         VALUES ('room_u1', 'other-slug', 'n', 'o', 'part_1')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("requires slug, name, objective and owner_id", async () => {
    for (const col of ["slug", "name", "objective", "owner_id"]) {
      const cols = ["id", "slug", "name", "objective", "owner_id"].filter((c) => c !== col);
      const vals = cols.map((_, i) => `$${i + 1}`);
      await expect(
        db.pool.query(
          `INSERT INTO rooms (${cols.join(", ")}) VALUES (${vals.join(", ")})`,
          cols.map((c) => `${c}_x`),
        ),
      ).rejects.toMatchObject({ code: "23502" }); // not_null_violation
    }
  });
});

describe("0002_events", () => {
  const ROOM = "room_ev";

  beforeAll(async () => {
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id)
       VALUES ($1, 'ev', 'n', 'o', 'part_1'), ('room_ev2', 'ev2', 'n', 'o', 'part_1')`,
      [ROOM],
    );
  });

  const insert = (room: string, seq: number, extra: Record<string, unknown> = {}) => {
    const cols = {
      room_id: room,
      sequence: seq,
      actor_id: "part_1",
      type: "room.created",
      payload_hash: "sha256:abc",
      ...extra,
    };
    const keys = Object.keys(cols);
    return db.pool.query(
      `INSERT INTO events (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      Object.values(cols),
    );
  };

  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 2");
    expect(rows).toEqual([{ name: "events" }]);
  });

  it("applies defaults for schema_version, timestamp, payload and redacted", async () => {
    const { rows } = await insert(ROOM, 1);
    expect(rows[0]).toMatchObject({
      schema_version: 1,
      payload: {},
      redacted: false,
      causation_id: null,
      sequence: "1",
    });
    expect(rows[0].timestamp).toBeInstanceOf(Date);
  });

  it("rejects a duplicate (room_id, sequence)", async () => {
    await insert(ROOM, 2);
    await expect(insert(ROOM, 2)).rejects.toMatchObject({ code: "23505" });
  });

  it("allows the same sequence in different rooms", async () => {
    await insert("room_ev2", 1);
    await insert("room_ev2", 2);
  });

  it("rejects an event for a room that doesn't exist", async () => {
    await expect(insert("room_missing", 1)).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects sequences below 1", async () => {
    await expect(insert(ROOM, 0)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(ROOM, -1)).rejects.toMatchObject({ code: "23514" });
  });

  it("stores payloads and causation ids", async () => {
    const { rows } = await insert(ROOM, 3, {
      causation_id: "cmd_01J",
      payload: JSON.stringify({ a: [1, 2] }),
    });
    expect(rows[0]).toMatchObject({ causation_id: "cmd_01J", payload: { a: [1, 2] } });
  });

  it("requires actor_id, type and payload_hash", async () => {
    for (const col of ["actor_id", "type", "payload_hash"]) {
      await expect(insert(ROOM, 100, { [col]: null })).rejects.toMatchObject({ code: "23502" });
    }
  });
});
