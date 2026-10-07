import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { newId, type RoomEvent } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerMessageCommands } from "../messages/messages.js";
import { registerTaskCommands } from "../tasks/create-update.js";
import { registerTaskLifecycleCommands } from "../tasks/lifecycle.js";
import type { TaskView } from "../tasks/task.js";
import { buildDigest, registerRoomDigestCommand, type Digest } from "./digest.js";

let db: TestDatabase;
let pool: Pool;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  await db.drop();
});

const cmd = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `k-${++n}`,
});
const read = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
});

async function add(room: string, role: string, authority = "MEMBER") {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'AGENT', $1, $3, $4, 'ACTIVE')`,
    [id, room, authority, role],
  );
  return { participant_id: id, room_id: room, kind: "AGENT", authority, role } as Principal;
}

async function setup() {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerTaskCommands(d);
  registerTaskLifecycleCommands(d);
  registerMessageCommands(d);
  registerRoomDigestCommand(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  return {
    d,
    room,
    lead: await add(room, "LEAD"),
    dev: await add(room, "DEVELOPER"),
    observer: await add(room, "OBSERVER"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const digest = async (s: Setup, who: Principal, params: Record<string, unknown> = {}) =>
  (await s.d.dispatch(who, read("room.digest", params))).response as Digest;

async function someActivity(s: Setup) {
  const a = (
    await s.d.dispatch(s.lead, cmd("tasks.create", { title: "Alpha", requirements: ["r"] }))
  ).response as TaskView;
  const b = (
    await s.d.dispatch(s.lead, cmd("tasks.create", { title: "Beta", requirements: ["r"] }))
  ).response as TaskView;
  const claimed = (
    await s.d.dispatch(s.dev, cmd("tasks.claim", { task_id: a.id, expected_version: a.version }))
  ).response as TaskView;
  await s.d.dispatch(
    s.dev,
    cmd("tasks.start", { task_id: a.id, expected_version: claimed.version }),
  );
  await s.d.dispatch(s.dev, cmd("messages.send", { body: "hello" }));
  await s.d.dispatch(s.dev, cmd("messages.send", { body: "again" }));
  return { a, b };
}

describe("room.digest", () => {
  it("counts events per type, with the keys sorted", async () => {
    const s = await setup();
    await someActivity(s);
    const d = await digest(s, s.lead);
    expect(d.counts).toMatchObject({
      "message.sent": 2,
      "task.claimed": 1,
      "task.created": 2,
      "task.started": 1,
    });
    expect(Object.keys(d.counts)).toEqual([...Object.keys(d.counts)].sort());
    expect(d.event_count).toBe(Object.values(d.counts).reduce((x, y) => x + y, 0));
    expect(d.since).toBe(0);
    expect(d.truncated).toBe(false);
  });

  it("lists the tasks that changed, in order of first change, with their titles", async () => {
    const s = await setup();
    const { a, b } = await someActivity(s);
    const d = await digest(s, s.lead);
    expect(d.tasks.map((t) => [t.task_id, t.title, t.event_count])).toEqual([
      [a.id, "Alpha", 3],
      [b.id, "Beta", 1],
    ]);
    expect(d.tasks[0]!.events.map((e) => e.type)).toEqual([
      "task.created",
      "task.claimed",
      "task.started",
    ]);
  });

  it("since limits it to what came after, and up_to is where to continue", async () => {
    const s = await setup();
    await someActivity(s);
    const all = await digest(s, s.lead);
    const mid = all.up_to - 2;
    const tail = await digest(s, s.lead, { since: mid });
    expect(tail.event_count).toBe(2);
    expect(tail.since).toBe(mid);
    expect(tail.up_to).toBe(all.up_to);
    expect(tail.counts).toEqual({ "message.sent": 2 });
    const none = await digest(s, s.lead, { since: all.up_to });
    expect(none).toMatchObject({ event_count: 0, up_to: all.up_to, counts: {}, tasks: [] });
  });

  it("the same range gives byte-identical output, whoever asks and however often", async () => {
    const s = await setup();
    await someActivity(s);
    const first = JSON.stringify(await digest(s, s.lead));
    expect(JSON.stringify(await digest(s, s.lead))).toBe(first);
    expect(JSON.stringify(await digest(s, s.dev))).toBe(first);
    expect(JSON.stringify(await digest(s, s.observer))).toBe(first);
  });

  it("reads past one page, in order, without losing or repeating an event", async () => {
    const s = await setup();
    for (let i = 0; i < 520; i++)
      await s.d.dispatch(s.dev, cmd("messages.send", { body: `m${i}` }));
    const d = await digest(s, s.lead);
    expect(d.counts).toEqual({ "message.sent": 520 });
    expect(d.event_count).toBe(520);
    expect(d.up_to).toBe(520);
  }, 120_000);

  it("reading it writes nothing and works for an observer", async () => {
    const s = await setup();
    await someActivity(s);
    const before = (
      await pool.query("SELECT count(*)::int AS n FROM events WHERE room_id = $1", [s.room])
    ).rows[0].n;
    await digest(s, s.observer);
    const after = (
      await pool.query("SELECT count(*)::int AS n FROM events WHERE room_id = $1", [s.room])
    ).rows[0].n;
    expect(after).toBe(before);
  });

  it("rejects a bad since", async () => {
    const s = await setup();
    for (const since of [-1, 1.5, "x"]) {
      await expect(s.d.dispatch(s.lead, read("room.digest", { since }))).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
  });
});

describe("buildDigest", () => {
  const ev = (sequence: number, type: string, payload: Record<string, unknown>): RoomEvent =>
    ({
      sequence,
      room_id: "room_x",
      actor_id: "part_x",
      type,
      schema_version: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      causation_id: "cmd_x",
      payload,
    }) as unknown as RoomEvent;

  it("lists decision events and the memory keys written, sorted and deduplicated", () => {
    const d = buildDigest(
      4,
      [
        ev(5, "decision.proposed", { decision: { id: "dec_1", title: "Use Postgres" } }),
        ev(6, "decision.position_added", { decision_id: "dec_1" }),
        ev(7, "memory.written", { key: "zeta" }),
        ev(8, "memory.written", { entry: { key: "alpha" } }),
        ev(9, "memory.written", { key: "zeta" }),
      ],
      false,
    );
    expect(d.decisions).toEqual([
      { sequence: 5, type: "decision.proposed", decision_id: "dec_1", title: "Use Postgres" },
      { sequence: 6, type: "decision.position_added", decision_id: "dec_1", title: null },
    ]);
    expect(d.memory_keys).toEqual(["alpha", "zeta"]);
    expect(d.up_to).toBe(9);
  });

  it("ignores a task event without a task id, and survives odd payloads", () => {
    const d = buildDigest(
      0,
      [ev(1, "task.updated", {}), ev(2, "memory.written", { key: 5 })],
      true,
    );
    expect(d.tasks).toEqual([]);
    expect(d.memory_keys).toEqual([]);
    expect(d.truncated).toBe(true);
    expect(d.counts).toEqual({ "memory.written": 1, "task.updated": 1 });
  });
});
