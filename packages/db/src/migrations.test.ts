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

describe("0009_tasks", () => {
  let n = 0;
  const room = async () => {
    const id = `room_t${++n}`;
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [id],
    );
    return id;
  };
  const participant = async (roomId: string) => {
    const id = `part_t${++n}`;
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, role, status)
       VALUES ($1, $2, 'AGENT', 'a', 'DEVELOPER', 'ACTIVE')`,
      [id, roomId],
    );
    return id;
  };
  const task = (roomId: string, by: string, extra: Record<string, unknown> = {}) => {
    const cols: Record<string, unknown> = {
      id: `task_${++n}`,
      room_id: roomId,
      title: "Do it",
      created_by: by,
      ...extra,
    };
    const keys = Object.keys(cols);
    return db.pool.query(
      `INSERT INTO tasks (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      Object.values(cols),
    );
  };

  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 9");
    expect(rows).toEqual([{ name: "tasks" }]);
  });

  it("defaults to an OPEN, unowned P2 task at version 1 that needs review", async () => {
    const r = await room();
    const { rows } = await task(r, await participant(r));
    expect(rows[0]).toMatchObject({
      status: "OPEN",
      owner_id: null,
      priority: 2,
      version: 1,
      review_required: true,
      override_dependencies: false,
      dependencies: [],
      requirements: [],
      artifacts: [],
      blocked_reason: null,
      lease_expires_at: null,
    });
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it("limits status to the §8.2 states and priority to 0–3", async () => {
    const r = await room();
    const p = await participant(r);
    for (const status of ["OPEN", "CANCELLED"]) await task(r, p, { status });
    for (const status of ["CLAIMED", "IN_PROGRESS", "BLOCKED", "REVIEW", "DONE"]) {
      await task(r, p, { status, owner_id: p, blocked_reason: "waiting" });
    }
    await expect(task(r, p, { status: "open" })).rejects.toMatchObject({ code: "23514" });
    await expect(task(r, p, { status: "STARTED" })).rejects.toMatchObject({ code: "23514" });
    for (const priority of [0, 1, 2, 3]) await task(r, p, { priority });
    for (const priority of [-1, 4]) {
      await expect(task(r, p, { priority })).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("requires a blocked_reason while BLOCKED", async () => {
    const r = await room();
    const p = await participant(r);
    for (const reason of [null, ""]) {
      await expect(
        task(r, p, { status: "BLOCKED", owner_id: p, blocked_reason: reason }),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await task(r, p, { status: "BLOCKED", owner_id: p, blocked_reason: "needs the API key" });
    // And it can't be cleared while the task stays blocked.
    const t = (await task(r, p, { status: "BLOCKED", owner_id: p, blocked_reason: "x" })).rows[0];
    await expect(
      db.pool.query("UPDATE tasks SET blocked_reason = NULL WHERE id = $1", [t.id]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps ownership consistent with status", async () => {
    const r = await room();
    const p = await participant(r);
    await expect(task(r, p, { status: "OPEN", owner_id: p })).rejects.toMatchObject({
      code: "23514",
    });
    for (const status of ["CLAIMED", "IN_PROGRESS", "REVIEW"]) {
      await expect(task(r, p, { status })).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("only refers to participants of the same room", async () => {
    const [a, b] = [await room(), await room()];
    const inA = await participant(a);
    const inB = await participant(b);
    await expect(task(a, inB)).rejects.toMatchObject({ code: "23503" }); // creator elsewhere
    await expect(task(a, inA, { reviewer_id: inB })).rejects.toMatchObject({ code: "23503" });
    await expect(task(a, inA, { status: "CLAIMED", owner_id: inB })).rejects.toMatchObject({
      code: "23503",
    });
    await expect(task("room_missing", inA)).rejects.toMatchObject({ code: "23503" });
  });

  it("requires JSON arrays for requirements and artifacts, and a non-empty title", async () => {
    const r = await room();
    const p = await participant(r);
    await task(r, p, { requirements: JSON.stringify(["a", "b"]), artifacts: JSON.stringify([]) });
    for (const extra of [
      { requirements: JSON.stringify({ a: 1 }) },
      { artifacts: JSON.stringify("x") },
      { title: "" },
    ]) {
      await expect(task(r, p, extra)).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("stores reviews against a task of the same room, with verdicts limited to APPROVE and REQUEST_CHANGES", async () => {
    const [a, b] = [await room(), await room()];
    const pa = await participant(a);
    const pb = await participant(b);
    const t = (await task(a, pa)).rows[0];
    const review = (roomId: string, taskId: string, reviewer: string, verdict: string) =>
      db.pool.query(
        `INSERT INTO task_reviews (id, room_id, task_id, reviewer_id, verdict, revision)
         VALUES ($1, $2, $3, $4, $5, 3)`,
        [`rev_${++n}`, roomId, taskId, reviewer, verdict],
      );
    await review(a, t.id, pa, "APPROVE");
    await review(a, t.id, pa, "REQUEST_CHANGES");
    await expect(review(a, t.id, pa, "approve")).rejects.toMatchObject({ code: "23514" });
    await expect(review(b, t.id, pb, "APPROVE")).rejects.toMatchObject({ code: "23503" });
    await expect(review(a, t.id, pb, "APPROVE")).rejects.toMatchObject({ code: "23503" });
    const { rows } = await db.pool.query(
      "SELECT comments, created_at FROM task_reviews WHERE task_id = $1",
      [t.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].comments).toBe("");
  });
});

describe("0010_messages", () => {
  let n = 0;
  const setup = async () => {
    const room = `room_m${++n}`;
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [room],
    );
    const part = async () => {
      const id = `part_m${++n}`;
      await db.pool.query(
        `INSERT INTO participants (id, room_id, kind, display_name, role, status)
         VALUES ($1, $2, 'AGENT', 'a', 'DEVELOPER', 'ACTIVE')`,
        [id, room],
      );
      return id;
    };
    return { room, author: await part() };
  };
  const send = (room: string, author: string, extra: Record<string, unknown> = {}) => {
    const cols: Record<string, unknown> = {
      id: `msg_${++n}`,
      room_id: room,
      author_id: author,
      body: "hi",
      ...extra,
    };
    const keys = Object.keys(cols);
    return db.pool.query(
      `INSERT INTO messages (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      Object.values(cols),
    );
  };

  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 10");
    expect(rows).toEqual([{ name: "messages" }]);
  });

  it("defaults to no mentions, no refs, not edited", async () => {
    const { room, author } = await setup();
    const { rows } = await send(room, author);
    expect(rows[0]).toMatchObject({ mentions: [], refs: [], reply_to: null, edited_at: null });
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it("limits the body to 1..32768 bytes (bytes, not characters)", async () => {
    const { room, author } = await setup();
    await send(room, author, { body: "x".repeat(32768) });
    await expect(send(room, author, { body: "x".repeat(32769) })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(send(room, author, { body: "" })).rejects.toMatchObject({ code: "23514" });
    await send(room, author, { body: "é".repeat(16384) }); // 32768 bytes
    await expect(send(room, author, { body: "é".repeat(16385) })).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("only takes an author of the same room, and a reply to a message of the same room", async () => {
    const a = await setup();
    const b = await setup();
    await expect(send(a.room, b.author)).rejects.toMatchObject({ code: "23503" });
    const m = (await send(a.room, a.author)).rows[0];
    await send(a.room, a.author, { reply_to: m.id });
    await expect(send(b.room, b.author, { reply_to: m.id })).rejects.toMatchObject({
      code: "23503",
    });
    await expect(send(a.room, a.author, { reply_to: "msg_nope" })).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("refs must be a JSON array", async () => {
    const { room, author } = await setup();
    await send(room, author, { refs: JSON.stringify([{ kind: "task", id: "task_1" }]) });
    await expect(
      send(room, author, { refs: JSON.stringify({ kind: "task" }) }),
    ).rejects.toMatchObject({
      code: "23514",
    });
  });
});

describe("0011_inbox_items", () => {
  let n = 0;
  const setup = async () => {
    const room = `room_i${++n}`;
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [room],
    );
    const id = `part_i${++n}`;
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, role, status)
       VALUES ($1, $2, 'AGENT', 'a', 'DEVELOPER', 'ACTIVE')`,
      [id, room],
    );
    return { room, who: id };
  };
  const item = (room: string, who: string, extra: Record<string, unknown> = {}) => {
    const cols: Record<string, unknown> = {
      id: `inbox_${++n}`,
      room_id: room,
      participant_id: who,
      kind: "MENTION",
      ref: JSON.stringify({ kind: "message", id: "msg_1" }),
      summary: "Look at this",
      author_id: "system",
      ...extra,
    };
    const keys = Object.keys(cols);
    return db.pool.query(
      `INSERT INTO inbox_items (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      Object.values(cols),
    );
  };

  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 11");
    expect(rows).toEqual([{ name: "inbox_items" }]);
  });

  it("starts unacknowledged", async () => {
    const { room, who } = await setup();
    const { rows } = await item(room, who);
    expect(rows[0]).toMatchObject({ acked_at: null, kind: "MENTION" });
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  it("belongs to a participant of the same room", async () => {
    const a = await setup();
    const b = await setup();
    await expect(item(a.room, b.who)).rejects.toMatchObject({ code: "23503" });
    await expect(item("room_missing", a.who)).rejects.toMatchObject({ code: "23503" });
  });

  it("checks the kind's shape, that ref is an object, and the summary's length", async () => {
    const { room, who } = await setup();
    for (const kind of ["mention", "", "MENTION!", "A".repeat(41)]) {
      await expect(item(room, who, { kind })).rejects.toMatchObject({ code: "23514" });
    }
    await expect(item(room, who, { ref: JSON.stringify(["x"]) })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(item(room, who, { summary: "" })).rejects.toMatchObject({ code: "23514" });
    await expect(item(room, who, { summary: "x".repeat(501) })).rejects.toMatchObject({
      code: "23514",
    });
    await item(room, who, { summary: "x".repeat(500) });
  });
});

describe("0012_decisions", () => {
  let n = 0;
  const setup = async () => {
    const room = `room_d${++n}`;
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [room],
    );
    const part = async () => {
      const id = `part_d${++n}`;
      await db.pool.query(
        `INSERT INTO participants (id, room_id, kind, display_name, role, status)
         VALUES ($1, $2, 'AGENT', 'a', 'DEVELOPER', 'ACTIVE')`,
        [id, room],
      );
      return id;
    };
    return { room, who: await part() };
  };
  const options = JSON.stringify([
    { id: "opt_1", summary: "a", detail: "" },
    { id: "opt_2", summary: "b", detail: "" },
  ]);
  const decision = (room: string, who: string, extra: Record<string, unknown> = {}) => {
    const cols: Record<string, unknown> = {
      id: `dec_${++n}`,
      room_id: room,
      title: "T",
      options,
      proposed_by: who,
      ...extra,
    };
    const keys = Object.keys(cols);
    return db.pool.query(
      `INSERT INTO decisions (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      Object.values(cols),
    );
  };

  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 12");
    expect(rows).toEqual([{ name: "decisions" }]);
  });

  it("starts PROPOSED at version 1", async () => {
    const { room, who } = await setup();
    const { rows } = await decision(room, who);
    expect(rows[0]).toMatchObject({ status: "PROPOSED", version: 1, links: [], decided_at: null });
  });

  it("needs two or more options, a known status and a sensible title", async () => {
    const { room, who } = await setup();
    await expect(
      decision(room, who, { options: JSON.stringify([{ id: "opt_1" }]) }),
    ).rejects.toMatchObject({
      code: "23514",
    });
    await expect(decision(room, who, { options: JSON.stringify({}) })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(decision(room, who, { status: "DONE" })).rejects.toMatchObject({ code: "23514" });
    await expect(decision(room, who, { title: "" })).rejects.toMatchObject({ code: "23514" });
    await expect(decision(room, who, { title: "x".repeat(201) })).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("an outcome needs a decision", async () => {
    const { room, who } = await setup();
    await expect(decision(room, who, { outcome_option_id: "opt_1" })).rejects.toMatchObject({
      code: "23514",
    });
    await decision(room, who, { status: "ACCEPTED", outcome_option_id: "opt_1" });
  });

  it("people are participants of the same room", async () => {
    const a = await setup();
    const b = await setup();
    await expect(decision(a.room, b.who)).rejects.toMatchObject({ code: "23503" });
    await expect(decision(a.room, a.who, { decided_by: b.who })).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("positions are one per participant, for a decision of the same room", async () => {
    const { room, who } = await setup();
    const other = await setup();
    const { rows } = await decision(room, who);
    const id = rows[0].id as string;
    const pos = (r: string, d: string, p: string) =>
      db.pool.query(
        `INSERT INTO decision_positions (decision_id, room_id, participant_id, option_id, argument)
         VALUES ($1, $2, $3, 'opt_1', 'why')`,
        [d, r, p],
      );
    await pos(room, id, who);
    await expect(pos(room, id, who)).rejects.toMatchObject({ code: "23505" });
    await expect(pos(other.room, id, other.who)).rejects.toMatchObject({ code: "23503" });
    await expect(
      db.pool.query(
        `INSERT INTO decision_positions (decision_id, room_id, participant_id, option_id, argument)
         VALUES ($1, $2, $3, 'opt_1', '')`,
        [id, room, (await setup()).who],
      ),
    ).rejects.toBeDefined();
  });
});

describe("0013_memory", () => {
  let n = 0;
  const room = async () => {
    const id = `room_mem${++n}`;
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [id],
    );
    return id;
  };
  const entry = (roomId: string, extra: Record<string, unknown> = {}) => {
    const cols: Record<string, unknown> = {
      room_id: roomId,
      key: `k${++n}`,
      value: "v",
      content_type: "text/markdown",
      author_id: "part_x",
      revision: 1,
      ...extra,
    };
    const keys = Object.keys(cols);
    return db.pool.query(
      `INSERT INTO memory_entries (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      Object.values(cols),
    );
  };

  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 13");
    expect(rows).toEqual([{ name: "memory" }]);
  });

  it("an entry is live at revision 1 with no source refs", async () => {
    const { rows } = await entry(await room());
    expect(rows[0]).toMatchObject({ revision: 1, deleted: false, source_refs: [] });
  });

  it("a key is unique within a room but may repeat across rooms", async () => {
    const a = await room();
    const b = await room();
    await entry(a, { key: "same" });
    await expect(entry(a, { key: "same" })).rejects.toMatchObject({ code: "23505" });
    await entry(b, { key: "same" });
  });

  it("checks the key, the content type, the revision and the 64 KiB value limit", async () => {
    const r = await room();
    await expect(entry(r, { key: "" })).rejects.toMatchObject({ code: "23514" });
    await expect(entry(r, { content_type: "text/plain" })).rejects.toMatchObject({ code: "23514" });
    await expect(entry(r, { revision: 0 })).rejects.toMatchObject({ code: "23514" });
    await entry(r, { value: "x".repeat(65536) });
    await expect(entry(r, { value: "x".repeat(65537) })).rejects.toMatchObject({ code: "23514" });
  });

  it("revisions belong to an entry and are unique per revision number", async () => {
    const r = await room();
    const { rows } = await entry(r);
    const key = rows[0].key as string;
    const rev = (k: string, revision: number) =>
      db.pool.query(
        `INSERT INTO memory_revisions (room_id, key, revision, value, content_type, author_id)
         VALUES ($1, $2, $3, 'v', 'text/markdown', 'part_x')`,
        [r, k, revision],
      );
    await rev(key, 1);
    await expect(rev(key, 1)).rejects.toMatchObject({ code: "23505" });
    await expect(rev("missing", 1)).rejects.toMatchObject({ code: "23503" });
  });
});

describe("0024_task_evidence", () => {
  const room = async () => {
    const id = `room_ev${Math.random().toString(36).slice(2)}`;
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [id],
    );
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, role, status)
       VALUES ($2, $1, 'AGENT', 'a', 'DEVELOPER', 'ACTIVE')`,
      [id, `${id}_p`],
    );
    return { id, who: `${id}_p` };
  };
  const task = (r: { id: string; who: string }, evidence?: string) =>
    db.pool.query(
      evidence === undefined
        ? `INSERT INTO tasks (id, room_id, title, requirements, created_by)
           VALUES ($1, $2, 't', '["r"]'::jsonb, $3) RETURNING evidence`
        : `INSERT INTO tasks (id, room_id, title, requirements, created_by, evidence)
           VALUES ($1, $2, 't', '["r"]'::jsonb, $3, $4::jsonb) RETURNING evidence`,
      [
        `task_${Math.random().toString(36).slice(2)}`,
        r.id,
        r.who,
        ...(evidence === undefined ? [] : [evidence]),
      ],
    );

  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 24");
    expect(rows).toEqual([{ name: "task_evidence" }]);
  });

  it("a task starts with no evidence, and evidence must be a JSON array", async () => {
    const r = await room();
    expect((await task(r)).rows[0].evidence).toEqual([]);
    await expect(task(r, '{"a":1}')).rejects.toMatchObject({ code: "23514" });
    await task(r, '[{"requirement":0,"proof":[{"kind":"test","ref":"x"}]}]');
  });

  it("evidence is capped at 32 KiB", async () => {
    const r = await room();
    const big = (n: number) => JSON.stringify([{ note: "x".repeat(n) }]);
    await task(r, big(32_000));
    await expect(task(r, big(33_000))).rejects.toMatchObject({ code: "23514" });
  });
});

describe("0025_inbox_item_authors", () => {
  let n = 0;
  const setup = async () => {
    const room = `room_ia${++n}`;
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [room],
    );
    const who = `part_ia${++n}`;
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, role, status)
       VALUES ($1, $2, 'AGENT', 'a', 'DEVELOPER', 'ACTIVE')`,
      [who, room],
    );
    return { room, who };
  };
  const insert = (room: string, who: string, author?: string) =>
    db.pool.query(
      `INSERT INTO inbox_items (id, room_id, participant_id, kind, ref, summary${author === undefined ? "" : ", author_id"})
       VALUES ($1, $2, $3, 'MENTION', '{}'::jsonb, 's'${author === undefined ? "" : ", $4"}) RETURNING author_id`,
      [`inbox_ia${++n}`, room, who, ...(author === undefined ? [] : [author])],
    );

  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 25");
    expect(rows).toEqual([{ name: "inbox_item_authors" }]);
  });

  it("a new item must say whose words it carries: there is no default", async () => {
    const { room, who } = await setup();
    await expect(insert(room, who)).rejects.toMatchObject({ code: "23502" });
    expect((await insert(room, who, "system")).rows[0].author_id).toBe("system");
    expect((await insert(room, who, who)).rows[0].author_id).toBe(who);
  });
});

describe("0018_upstream", () => {
  let n = 0;
  const setup = async () => {
    const room = `room_up${++n}`;
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [room],
    );
    const who = `part_up${++n}`;
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, role, status)
       VALUES ($1, $2, 'HUMAN', 'a', 'LEAD', 'ACTIVE')`,
      [who, room],
    );
    const ws = `ws_up${++n}`;
    await db.pool.query(`INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, '/x')`, [
      ws,
      room,
    ]);
    return { room, who, ws };
  };
  const upstream = (
    c: { room: string; who: string; ws: string },
    extra: Record<string, unknown> = {},
  ) => {
    const cols: Record<string, unknown> = {
      room_id: c.room,
      workspace_id: c.ws,
      url: "https://github.com/acme/widgets",
      branch: "main",
      last_synced_sha: "a".repeat(40),
      last_synced_room_revision: 1,
      imported_by: c.who,
      ...extra,
    };
    const keys = Object.keys(cols);
    return db.pool.query(
      `INSERT INTO upstreams (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      Object.values(cols),
    );
  };

  it("is recorded as applied", async () => {
    const { rows } = await db.pool.query("SELECT name FROM schema_migrations WHERE version = 18");
    expect(rows).toEqual([{ name: "upstream" }]);
  });

  it("one upstream per room, with a SHA-1 or SHA-256 commit id", async () => {
    const c = await setup();
    await upstream(c);
    await expect(upstream(c)).rejects.toMatchObject({ code: "23505" });
    const d = await setup();
    await upstream(d, { last_synced_sha: "b".repeat(64) });
    const e = await setup();
    for (const sha of ["", "abc", "A".repeat(40), "g".repeat(40)]) {
      await expect(upstream(e, { last_synced_sha: sha })).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("never stores a URL that carries credentials, or one that isn't https", async () => {
    const c = await setup();
    for (const url of [
      "https://user:pw@github.com/a/b",
      "https://token@github.com/a/b",
      "http://github.com/a/b",
      "ssh://github.com/a/b",
      "",
    ]) {
      await expect(upstream(c, { url })).rejects.toMatchObject({ code: "23514" });
    }
    await upstream(c, { url: "https://gitlab.example.com/group/sub/repo.git" });
  });

  it("the room revision starts at 1, and the importer is a participant of the same room", async () => {
    const c = await setup();
    await expect(upstream(c, { last_synced_room_revision: 0 })).rejects.toMatchObject({
      code: "23514",
    });
    const other = await setup();
    await expect(upstream(c, { imported_by: other.who })).rejects.toMatchObject({ code: "23503" });
  });
});

describe("0019_checkpoints", () => {
  let n = 0;
  const setup = async () => {
    const room = `room_ck${++n}`;
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [room],
    );
    const who = `part_ck${n}`;
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, role, status)
       VALUES ($1, $2, 'HUMAN', 'a', 'LEAD', 'ACTIVE')`,
      [who, room],
    );
    await db.pool.query(
      `INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, '/tmp/x')`,
      [`ws_ck${n}`, room],
    );
    await db.pool.query(
      `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
       VALUES ($1, $2, 1, $3)`,
      [`ws_ck${n}`, room, "a".repeat(40)],
    );
    return { room, who, ws: `ws_ck${n}` };
  };
  const insert = (
    c: { room: string; who: string; ws: string },
    over: Record<string, unknown> = {},
  ) => {
    const v = { revision: 1, message: "m", health_status: "GREEN", overridden: false, ...over };
    return db.pool.query(
      `INSERT INTO checkpoints (id, room_id, workspace_id, revision, message, created_by, health_status, overridden)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [`ckpt_${++n}`, c.room, c.ws, v.revision, v.message, c.who, v.health_status, v.overridden],
    );
  };

  it("a checkpoint marks an existing revision of the room, once", async () => {
    const c = await setup();
    await insert(c);
    await expect(insert(c)).rejects.toMatchObject({ code: "23505" });
    await expect(insert(c, { revision: 7 })).rejects.toMatchObject({ code: "23503" });
  });

  it("a non-green health is only stored as an override, and the message is 1-500 characters", async () => {
    const c = await setup();
    await expect(insert(c, { health_status: "RED" })).rejects.toMatchObject({ code: "23514" });
    await insert(c, { health_status: "RED", overridden: true });
    const d = await setup();
    await expect(insert(d, { message: "" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert(d, { message: "x".repeat(501) })).rejects.toMatchObject({ code: "23514" });
  });
});

describe("0026_redaction", () => {
  it("a message may be empty only once it is redacted", async () => {
    const room = "room_rd1";
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [room],
    );
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, role, status)
       VALUES ('part_rd1', $1, 'HUMAN', 'a', 'LEAD', 'ACTIVE')`,
      [room],
    );
    const insert = (id: string, body: string, redacted: boolean) =>
      db.pool.query(
        `INSERT INTO messages (id, room_id, author_id, body, redacted) VALUES ($1, $2, 'part_rd1', $3, $4)`,
        [id, room, body, redacted],
      );
    await expect(insert("msg_rd1", "", false)).rejects.toMatchObject({ code: "23514" });
    await insert("msg_rd2", "", true);
    await insert("msg_rd3", "text", false);
    await expect(insert("msg_rd4", "x".repeat(32769), true)).rejects.toMatchObject({
      code: "23514",
    });
  });
});
