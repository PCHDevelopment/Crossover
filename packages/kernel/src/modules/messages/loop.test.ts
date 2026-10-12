import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerDecisionCommands } from "../decisions/decisions.js";
import { registerMemoryCommands } from "../memory/memory.js";
import { registerTaskCommands } from "../tasks/create-update.js";
import { LOOP_MESSAGE_LIMIT, LOOP_THROTTLE_SECONDS } from "./loop.js";
import { registerMessageCommands } from "./messages.js";

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

async function add(
  room: string,
  role: string,
  kind: "AGENT" | "HUMAN" = "AGENT",
  authority = "MEMBER",
) {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, $3, $1, $4, $5, 'ACTIVE')`,
    [id, room, kind, authority, role],
  );
  return { participant_id: id, room_id: room, kind, authority, role } as Principal;
}

async function setup() {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerMessageCommands(d);
  registerTaskCommands(d);
  registerMemoryCommands(d);
  registerDecisionCommands(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  return {
    d,
    room,
    lead: await add(room, "LEAD"),
    owner: await add(room, "DEVELOPER", "HUMAN", "OWNER"),
    a: await add(room, "DEVELOPER"),
    b: await add(room, "DEVELOPER"),
    c: await add(room, "DEVELOPER"),
    human: await add(room, "DEVELOPER", "HUMAN"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const say = (s: Setup, who: Principal, body = "hi") =>
  s.d.dispatch(who, cmd("messages.send", { body }));

/** `count` messages, alternating between `who`. */
async function chat(s: Setup, who: Principal[], count: number) {
  for (let i = 0; i < count; i++) await say(s, who[i % who.length]!, `m${i}`);
}

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

const loopEvents = async (s: Setup) =>
  (
    await pool.query(
      "SELECT payload, actor_id FROM events WHERE room_id = $1 AND type = 'loop.detected' ORDER BY sequence",
      [s.room],
    )
  ).rows as { payload: Record<string, unknown>; actor_id: string }[];
const inbox = async (s: Setup, who: Principal) =>
  (
    await pool.query(
      "SELECT kind, ref, summary FROM inbox_items WHERE room_id = $1 AND participant_id = $2",
      [s.room, who.participant_id],
    )
  ).rows as { kind: string; ref: { kind: string; id: string }; summary: string }[];
/** Pretend `who`'s last message was `seconds` ago. */
const ageMessages = (s: Setup, seconds: number) =>
  pool.query(
    "UPDATE messages SET created_at = created_at - make_interval(secs => $2) WHERE room_id = $1",
    [s.room, seconds],
  );

describe("loop protection (§17.6)", () => {
  it("20 messages between two agents is fine; the 21st is accepted and detects the loop", async () => {
    const s = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT);
    expect(await loopEvents(s)).toEqual([]);
    const out = await say(s, s.a, "the 21st");
    expect(out.events.map((e) => e.type)).toEqual(["message.sent", "loop.detected"]);
    const [ev] = await loopEvents(s);
    expect(ev!.actor_id).toBe("system");
    expect(ev!.payload).toMatchObject({
      participants: [s.a.participant_id, s.b.participant_id].sort(),
      consecutive_messages: 21,
      throttle_seconds: LOOP_THROTTLE_SECONDS,
    });
  });

  it("the lead and the owner each get exactly one inbox item; nobody else does", async () => {
    const s = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT + 1);
    for (const who of [s.lead, s.owner]) {
      const items = await inbox(s, who);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: "LOOP_DETECTED" });
      expect(items[0]!.summary).toContain("21 messages");
    }
    for (const who of [s.a, s.b, s.c, s.human]) expect(await inbox(s, who)).toEqual([]);
  });

  it("afterwards each agent in the loop is limited to one message a minute: RATE_LIMITED", async () => {
    const s = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT + 1);
    for (const who of [s.a, s.b]) {
      const err = await rejects(say(s, who), "RATE_LIMITED");
      expect(err.retryable).toBe(true);
      expect(err.details).toMatchObject({ reason: "loop_throttle" });
      expect(err.details!.retry_after).toBeGreaterThan(0);
      expect(err.details!.retry_after).toBeLessThanOrEqual(LOOP_THROTTLE_SECONDS);
    }
    // A refused message writes nothing, and the loop is announced only once.
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM messages WHERE room_id = $1",
      [s.room],
    );
    expect(rows[0].n).toBe(LOOP_MESSAGE_LIMIT + 1);
    expect(await loopEvents(s)).toHaveLength(1);
  });

  it("the limit lifts after a minute, one message at a time", async () => {
    const s = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT + 1);
    await ageMessages(s, LOOP_THROTTLE_SECONDS + 1);
    await say(s, s.a); // allowed: a's last message is over a minute old
    await rejects(say(s, s.a), "RATE_LIMITED"); // …but only one
    await say(s, s.b);
    await rejects(say(s, s.b), "RATE_LIMITED");
    expect(await loopEvents(s)).toHaveLength(1);
  });

  it("an agent outside the loop may speak once; by joining it, it is throttled like the rest", async () => {
    const s = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT + 1);
    await say(s, s.c); // not one of the agents in the run when it began
    await rejects(say(s, s.c, "again"), "RATE_LIMITED");
  });

  it("an agent that spoke a moment ago but isn't in the loop is not throttled by it", async () => {
    const s = await setup();
    await say(s, s.c, "earlier, before the loop");
    await s.d.dispatch(
      s.lead,
      cmd("memory.put", { key: "notes/z", value: "v", expected_revision: 0 }),
    ); // a state change: c's message is no longer part of the run
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT + 1);
    await rejects(say(s, s.a), "RATE_LIMITED");
    await say(s, s.c, "c is free to speak, and joins the run");
  });

  it("a human sending the message that would be the 21st neither detects nor is throttled", async () => {
    const s = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT);
    await say(s, s.human, "I'm here");
    await say(s, s.human, "and again");
    expect(await loopEvents(s)).toEqual([]);
    expect(await inbox(s, s.lead)).toEqual([]);
  });

  it("a human's message ends the run, and a throttled agent may then speak", async () => {
    const s = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT + 1);
    await rejects(say(s, s.a), "RATE_LIMITED");
    await say(s, s.human, "stop it, both of you");
    await say(s, s.a, "sorry");
    await say(s, s.b, "ok");
    expect(await loopEvents(s)).toHaveLength(1);
  });

  it("a task update resets the counter (the acceptance case)", async () => {
    const s = await setup();
    const task = (
      await s.d.dispatch(s.lead, cmd("tasks.create", { title: "Work", requirements: ["r"] }))
    ).response as { id: string; version: number };
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT);
    await s.d.dispatch(
      s.lead,
      cmd("tasks.update", { task_id: task.id, expected_version: task.version, priority: 1 }),
    );
    // Not throttled, and it takes another full run of more than 20 to detect a loop again.
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT);
    expect(await loopEvents(s)).toEqual([]);
    await say(s, s.a, "the 21st since the update");
    expect(await loopEvents(s)).toHaveLength(1);
  });

  it("a memory write or a decision also resets it", async () => {
    const s = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT);
    await s.d.dispatch(
      s.lead,
      cmd("memory.put", { key: "notes/x", value: "v", expected_revision: 0 }),
    );
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT);
    expect(await loopEvents(s)).toEqual([]);
    await s.d.dispatch(
      s.lead,
      cmd("decisions.propose", {
        title: "t",
        options: [{ summary: "x" }, { summary: "y" }],
      }),
    );
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT);
    expect(await loopEvents(s)).toEqual([]);
  });

  it("a ChangeSet resets it too", async () => {
    const s = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT);
    await s.d.runSystem(s.room, "test.changeset", async () => ({
      result: null,
      events: [
        { type: "workspace.changeset.applied" as const, actor_id: s.a.participant_id, payload: {} },
      ],
    }));
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT);
    expect(await loopEvents(s)).toEqual([]);
  });

  it("one agent talking to itself isn't an exchange between agents: no loop, no throttle", async () => {
    const s = await setup();
    await chat(s, [s.a], LOOP_MESSAGE_LIMIT + 10);
    expect(await loopEvents(s)).toEqual([]);
  });

  it("a monologue that a second agent joins past the limit is detected at that moment", async () => {
    const s = await setup();
    await chat(s, [s.a], LOOP_MESSAGE_LIMIT + 5);
    expect(await loopEvents(s)).toEqual([]);
    const out = await say(s, s.b, "mind if I join?");
    expect(out.events.map((e) => e.type)).toEqual(["message.sent", "loop.detected"]);
    const [ev] = await loopEvents(s);
    expect(ev!.payload).toMatchObject({
      participants: [s.a.participant_id, s.b.participant_id].sort(),
    });
    expect(Number(ev!.payload.consecutive_messages)).toBeGreaterThan(LOOP_MESSAGE_LIMIT);
    expect((await inbox(s, s.lead))[0]).toMatchObject({ kind: "LOOP_DETECTED" });
    // Both are now throttled, and it isn't announced again.
    await rejects(say(s, s.a), "RATE_LIMITED");
    await rejects(say(s, s.b), "RATE_LIMITED");
    expect(await loopEvents(s)).toHaveLength(1);
  });

  it("unrelated events between messages (denials, health) neither hide a loop nor lift the throttle", async () => {
    const s = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT + 1);
    // Far more neutral events than the scan window holds.
    await s.d.runSystem(s.room, "test.noise", async () => ({
      result: null,
      events: Array.from({ length: 300 }, (_, i) => ({
        type: i % 2 ? ("capability.denied" as const) : ("workspace.health" as const),
        actor_id: "system",
        payload: {},
      })),
    }));
    await rejects(say(s, s.a), "RATE_LIMITED");
    await rejects(say(s, s.b), "RATE_LIMITED");
    expect(await loopEvents(s)).toHaveLength(1);
  });

  it("noise before the 21st message doesn't hide the loop it completes", async () => {
    const s = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT);
    await s.d.runSystem(s.room, "test.noise", async () => ({
      result: null,
      events: Array.from({ length: 300 }, () => ({
        type: "capability.denied" as const,
        actor_id: "system",
        payload: {},
      })),
    }));
    const out = await say(s, s.a, "the 21st");
    expect(out.events.map((e) => e.type)).toEqual(["message.sent", "loop.detected"]);
  });

  it("a second loop after a reset is detected and announced again", async () => {
    const s = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT + 1);
    await s.d.dispatch(
      s.lead,
      cmd("memory.put", { key: "notes/y", value: "v", expected_revision: 0 }),
    );
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT + 1);
    expect(await loopEvents(s)).toHaveLength(2);
    expect(await inbox(s, s.lead)).toHaveLength(2);
  });

  it("the throttle is per room", async () => {
    const s = await setup();
    const other = await setup();
    await chat(s, [s.a, s.b], LOOP_MESSAGE_LIMIT + 1);
    await rejects(say(s, s.a), "RATE_LIMITED");
    await say(other, other.a);
    await say(other, other.a, "twice is fine elsewhere");
  });
});
