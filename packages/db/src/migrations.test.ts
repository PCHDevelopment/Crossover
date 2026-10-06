import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "./index.js";
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

describe("0005_participants", () => {
  let n = 0;
  const makeRoom = async (): Promise<string> => {
    const id = `room_p${++n}`;
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [id],
    );
    return id;
  };

  const add = (room: string, extra: Record<string, unknown> = {}) => {
    const cols: Record<string, unknown> = {
      id: `part_${++n}`,
      room_id: room,
      kind: "HUMAN",
      display_name: "Ada",
      role: "DEVELOPER",
      ...extra,
    };
    const keys = Object.keys(cols);
    return db.pool.query(
      `INSERT INTO participants (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      Object.values(cols),
    );
  };

  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 5");
    expect(rows).toEqual([{ name: "participants" }]);
  });

  it("defaults to a MEMBER, INVITED participant with empty budgets and no timestamps", async () => {
    const [room] = [await makeRoom()];
    const { rows } = await add(room);
    expect(rows[0]).toMatchObject({
      authority: "MEMBER",
      status: "INVITED",
      budgets: {},
      agent_manifest: null,
      user_id: null,
      joined_at: null,
      last_seen_at: null,
    });
  });

  describe("one owner per room", () => {
    it("rejects a second owner in a room", async () => {
      const room = await makeRoom();
      await add(room, { authority: "OWNER" });
      await expect(add(room, { authority: "OWNER" })).rejects.toMatchObject({ code: "23505" });
    });

    it("allows an owner in each of several rooms, and any number of admins and members", async () => {
      const [a, b] = [await makeRoom(), await makeRoom()];
      await add(a, { authority: "OWNER" });
      await add(b, { authority: "OWNER" });
      await add(a, { authority: "ADMIN" });
      await add(a, { authority: "ADMIN" });
      await add(a);
      await add(a, { kind: "AGENT" });
    });

    it("rejects promoting a second participant to owner, but allows handing ownership over in one step", async () => {
      const room = await makeRoom();
      const owner = (await add(room, { authority: "OWNER" })).rows[0];
      const other = (await add(room)).rows[0];
      await expect(
        db.pool.query("UPDATE participants SET authority = 'OWNER' WHERE id = $1", [other.id]),
      ).rejects.toMatchObject({ code: "23505" });
      await withTransaction(db.pool, async (c) => {
        await c.query("UPDATE participants SET authority = 'ADMIN' WHERE id = $1", [owner.id]);
        await c.query("UPDATE participants SET authority = 'OWNER' WHERE id = $1", [other.id]);
      });
      const { rows } = await db.pool.query(
        "SELECT id FROM participants WHERE room_id = $1 AND authority = 'OWNER'",
        [room],
      );
      expect(rows).toEqual([{ id: other.id }]);
    });
  });

  describe("agents can't govern (D8)", () => {
    it("rejects an agent with OWNER or ADMIN authority", async () => {
      const room = await makeRoom();
      for (const authority of ["OWNER", "ADMIN"]) {
        await expect(add(room, { kind: "AGENT", authority })).rejects.toMatchObject({
          code: "23514",
        });
      }
    });

    it("rejects turning an existing agent into an admin", async () => {
      const room = await makeRoom();
      const agent = (await add(room, { kind: "AGENT" })).rows[0];
      await expect(
        db.pool.query("UPDATE participants SET authority = 'ADMIN' WHERE id = $1", [agent.id]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.pool.query("UPDATE participants SET kind = 'AGENT' WHERE id = $1", [
          (await add(room, { authority: "ADMIN" })).rows[0].id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("accepts agents as members with any role, and humans as owner or admin", async () => {
      const room = await makeRoom();
      for (const role of ["LEAD", "DEVELOPER", "REVIEWER", "OBSERVER"]) {
        await add(room, { kind: "AGENT", role });
      }
      await add(room, { authority: "OWNER" });
      await add(room, { authority: "ADMIN" });
    });
  });

  it("limits user_id to humans and agent_manifest to agents", async () => {
    const room = await makeRoom();
    await db.pool.query(
      "INSERT INTO users (id, display_name, provider, provider_subject) VALUES ('user_1', 'U', 'test', 'u1') ON CONFLICT DO NOTHING",
    );
    await add(room, { user_id: "user_1" });
    await add(room, { kind: "AGENT", agent_manifest: JSON.stringify({ name: "bot" }) });
    await expect(add(room, { kind: "AGENT", user_id: "user_1" })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      add(room, { kind: "HUMAN", agent_manifest: JSON.stringify({ name: "bot" }) }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects values outside the kind, authority, role and status enums, including wrong case", async () => {
    const room = await makeRoom();
    const bad: Record<string, unknown>[] = [
      { kind: "ROBOT" },
      { kind: "human" },
      { authority: "ROOT" },
      { authority: "member" },
      { role: "BOSS" },
      { role: "lead" },
      { status: "GONE" },
      { status: "active" },
    ];
    for (const patch of bad) {
      await expect(add(room, patch), JSON.stringify(patch)).rejects.toMatchObject({
        code: "23514",
      });
    }
    for (const status of ["INVITED", "ACTIVE", "PAUSED", "REMOVED"]) {
      await add(room, { status });
    }
  });

  it("requires room_id, kind, display_name and role, and an existing room", async () => {
    const room = await makeRoom();
    for (const col of ["room_id", "kind", "display_name", "role"]) {
      await expect(add(room, { [col]: null })).rejects.toMatchObject({ code: "23502" });
    }
    await expect(add("room_missing")).rejects.toMatchObject({ code: "23503" });
  });

  it("enforces unique ids, and lets room-scoped tables reference (id, room_id)", async () => {
    const [a, b] = [await makeRoom(), await makeRoom()];
    const p = (await add(a)).rows[0];
    await expect(add(b, { id: p.id })).rejects.toMatchObject({ code: "23505" });

    await db.pool.query(`
      CREATE TABLE t201_child (
        id text PRIMARY KEY, room_id text NOT NULL, participant_id text NOT NULL,
        FOREIGN KEY (participant_id, room_id) REFERENCES participants (id, room_id)
      )`);
    await db.pool.query("INSERT INTO t201_child VALUES ('c1', $1, $2)", [a, p.id]);
    // The same participant under another room's id is rejected.
    await expect(
      db.pool.query("INSERT INTO t201_child VALUES ('c2', $1, $2)", [b, p.id]),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("can't delete a room that still has participants", async () => {
    const room = await makeRoom();
    await add(room);
    await expect(db.pool.query("DELETE FROM rooms WHERE id = $1", [room])).rejects.toMatchObject({
      code: "23503",
    });
  });
});
