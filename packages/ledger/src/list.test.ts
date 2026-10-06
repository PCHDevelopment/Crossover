import type { Pool } from "@crossover/db";
import { withTransaction } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendEvents, type NewEvent } from "./append.js";
import { acquireLease } from "./lease.js";
import { listEvents, MAX_LIST_LIMIT } from "./list.js";

let db: TestDatabase;
let pool: Pool;
let counter = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  await db.drop();
});

const tokens = new Map<string, number>();

/** A new room whose lease (1 hour) is held by this test; seed() uses its fencing token. */
async function newRoom(): Promise<string> {
  const id = `room_${++counter}`;
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'part_1')`,
    [id],
  );
  tokens.set(id, (await acquireLease(pool, id, "node-test", 3_600_000))!.fencing_token);
  return id;
}

const ev = (type: NewEvent["type"], n = 0): NewEvent => ({
  actor_id: "part_1",
  type,
  payload: { n },
});

async function seed(room: string, types: NewEvent["type"][]): Promise<void> {
  await withTransaction(pool, (c) =>
    appendEvents(
      c,
      room,
      types.map((t, i) => ev(t, i)),
      tokens.get(room)!,
    ),
  );
}

describe("listEvents", () => {
  it("returns only events with sequence > after, in ascending order", async () => {
    const room = await newRoom();
    await seed(room, [
      "room.created",
      "message.sent",
      "message.sent",
      "task.created",
      "task.updated",
    ]);
    expect((await listEvents(pool, room)).map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect((await listEvents(pool, room, { after: 0 })).map((e) => e.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect((await listEvents(pool, room, { after: 2 })).map((e) => e.sequence)).toEqual([3, 4, 5]);
    expect(await listEvents(pool, room, { after: 5 })).toEqual([]);
    expect(await listEvents(pool, room, { after: 99 })).toEqual([]);
  });

  it("returns §19.1 events", async () => {
    const room = await newRoom();
    await seed(room, ["task.created"]);
    const [e] = await listEvents(pool, room);
    expect(e).toMatchObject({
      sequence: 1,
      room_id: room,
      type: "task.created",
      payload: { n: 0 },
      redacted: false,
    });
  });

  it("only returns the requested room's events", async () => {
    const [a, b] = [await newRoom(), await newRoom()];
    await seed(a, ["message.sent", "message.sent"]);
    await seed(b, ["task.created"]);
    expect((await listEvents(pool, a)).map((e) => e.room_id)).toEqual([a, a]);
    expect((await listEvents(pool, b)).map((e) => e.type)).toEqual(["task.created"]);
    expect(await listEvents(pool, "room_unknown")).toEqual([]);
  });

  it("works on a transaction client too", async () => {
    const room = await newRoom();
    await seed(room, ["message.sent"]);
    const seen = await withTransaction(pool, (c) => listEvents(c, room));
    expect(seen).toHaveLength(1);
  });

  describe("limit", () => {
    let room: string;
    beforeAll(async () => {
      room = await newRoom();
      // 600 events, inserted directly for speed.
      await pool.query(
        `INSERT INTO events (room_id, sequence, actor_id, type, payload_hash)
         SELECT $1, g, 'part_1', 'message.sent', 'sha256:' || repeat('0', 64)
           FROM generate_series(1, 600) g`,
        [room],
      );
    });

    it("defaults to 100", async () => {
      expect(await listEvents(pool, room)).toHaveLength(100);
    });

    it("honors a smaller limit and starts at after + 1", async () => {
      const rows = await listEvents(pool, room, { after: 10, limit: 3 });
      expect(rows.map((e) => e.sequence)).toEqual([11, 12, 13]);
    });

    it("is capped at 500", async () => {
      const rows = await listEvents(pool, room, { limit: 100000 });
      expect(MAX_LIST_LIMIT).toBe(500);
      expect(rows).toHaveLength(500);
      expect(rows[499]!.sequence).toBe(500);
    });

    it("pages through the whole room with after", async () => {
      const seen: number[] = [];
      let after = 0;
      for (;;) {
        const page = await listEvents(pool, room, { after, limit: 250 });
        if (page.length === 0) break;
        seen.push(...page.map((e) => e.sequence));
        after = page[page.length - 1]!.sequence;
      }
      expect(seen).toEqual(Array.from({ length: 600 }, (_, i) => i + 1));
    });

    it("rejects invalid limit and after", async () => {
      for (const bad of [0, -1, 1.5, NaN]) {
        await expect(listEvents(pool, room, { limit: bad })).rejects.toMatchObject({
          code: "VALIDATION",
        });
      }
      for (const bad of [-1, 1.5, NaN]) {
        await expect(listEvents(pool, room, { after: bad })).rejects.toMatchObject({
          code: "VALIDATION",
        });
      }
    });
  });

  describe("types", () => {
    let room: string;
    beforeAll(async () => {
      room = await newRoom();
      await seed(room, [
        "room.created",
        "task.created",
        "task.updated",
        "message.sent",
        "workspace.conflict.created",
        "workspace.changeset.applied",
        "task.claimed",
      ]);
      // Types that merely look similar; only reachable by direct insert.
      await pool.query(
        `INSERT INTO events (room_id, sequence, actor_id, type, payload_hash)
         VALUES ($1, 8, 'p', 'tasks_x', 'sha256:00'), ($1, 9, 'p', 'tasks.created', 'sha256:00'),
                ($1, 10, 'p', 'task', 'sha256:00')`,
        [room],
      );
    });

    const types = async (patterns: string[]) =>
      (await listEvents(pool, room, { types: patterns })).map((e) => e.type);

    it("matches exact names", async () => {
      expect(await types(["task.created"])).toEqual(["task.created"]);
      expect(await types(["task.created", "message.sent"])).toEqual([
        "task.created",
        "message.sent",
      ]);
    });

    it("task.* matches task.created but not tasks_x, tasks.created or task", async () => {
      expect(await types(["task.*"])).toEqual(["task.created", "task.updated", "task.claimed"]);
    });

    it("matches nested wildcards", async () => {
      expect(await types(["workspace.*"])).toEqual([
        "workspace.conflict.created",
        "workspace.changeset.applied",
      ]);
      expect(await types(["workspace.conflict.*"])).toEqual(["workspace.conflict.created"]);
    });

    it("combines patterns without duplicating events", async () => {
      expect(await types(["task.*", "task.created", "room.created"])).toEqual([
        "room.created",
        "task.created",
        "task.updated",
        "task.claimed",
      ]);
    });

    it("applies types together with after and limit", async () => {
      const rows = await listEvents(pool, room, { types: ["task.*"], after: 2, limit: 1 });
      expect(rows.map((e) => e.sequence)).toEqual([3]);
    });

    it("rejects unknown types, empty and over-broad wildcards, and an empty list", async () => {
      for (const bad of [["task.exploded"], ["foo.*"], ["*"], [".*"], ["task.%"], ["task"], []]) {
        await expect(listEvents(pool, room, { types: bad })).rejects.toMatchObject({
          code: "VALIDATION",
        });
      }
    });

    it("treats SQL wildcards as literal text", async () => {
      await expect(listEvents(pool, room, { types: ["%"] })).rejects.toMatchObject({
        code: "VALIDATION",
      });
    });
  });
});
