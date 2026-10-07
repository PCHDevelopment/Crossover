import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerTaskCommands } from "./create-update.js";
import { registerTaskLifecycleCommands } from "./lifecycle.js";
import { registerTaskHeartbeat, sweepExpiredLeases, SYSTEM_ACTOR } from "./leases.js";
import type { TaskView } from "./task.js";

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
  kind: "HUMAN" | "AGENT",
  authority = "MEMBER",
): Promise<Principal> {
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
  registerTaskCommands(d);
  registerTaskLifecycleCommands(d);
  registerTaskHeartbeat(d);
  const room = newId("room");
  const ownerId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', $2)`,
    [room, ownerId],
  );
  const agents = [];
  for (let i = 0; i < 3; i++) agents.push(await add(room, "DEVELOPER", "AGENT"));
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'owner', 'OWNER', 'DEVELOPER', 'ACTIVE')`,
    [ownerId, room],
  );
  return {
    d,
    room,
    agents,
    agent: agents[0]!,
    lead: await add(room, "LEAD", "AGENT"),
    owner: {
      participant_id: ownerId,
      room_id: room,
      kind: "HUMAN",
      authority: "OWNER",
      role: "DEVELOPER",
    } as Principal,
    admin: await add(room, "DEVELOPER", "HUMAN", "ADMIN"),
    human: await add(room, "DEVELOPER", "HUMAN"),
    reviewer: await add(room, "REVIEWER", "AGENT"),
    observer: await add(room, "OBSERVER", "AGENT"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const claim = (s: Setup, who: Principal, task: Pick<TaskView, "id" | "version">) =>
  s.d.dispatch(who, cmd("tasks.claim", { task_id: task.id, expected_version: task.version }));

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

const start = (s: Setup, who: Principal, task: Pick<TaskView, "id" | "version">) =>
  s.d.dispatch(who, cmd("tasks.start", { task_id: task.id, expected_version: task.version }));
const submit = (s: Setup, who: Principal, task: Pick<TaskView, "id" | "version">) =>
  s.d.dispatch(who, cmd("tasks.submit", { task_id: task.id, expected_version: task.version }));
const heartbeat = (s: Setup, who: Principal, taskId: string) =>
  s.d.dispatch(who, cmd("tasks.heartbeat", { task_id: taskId }));
const claimed = async (s: Setup, who: Principal) => {
  const t = (await s.d.dispatch(s.agent, cmd("tasks.create", { title: "T", requirements: ["r"] })))
    .response as TaskView;
  return (await claim(s, who, t)).response as TaskView;
};
const setLease = (id: string, sql: string) =>
  pool.query(`UPDATE tasks SET lease_expires_at = ${sql} WHERE id = $1`, [id]);
const row = async (id: string) =>
  (
    await pool.query(
      "SELECT status, owner_id, version, lease_expires_at, blocked_reason FROM tasks WHERE id = $1",
      [id],
    )
  ).rows[0];

const T0 = new Date("2020-01-01T00:00:00Z");
const at = (secondsFromT0: number) => new Date(T0.getTime() + secondsFromT0 * 1000);
const expireAtT0 = (id: string) => setLease(id, `'${T0.toISOString()}'::timestamptz`);

describe("tasks.heartbeat", () => {
  it("renews an agent's lease without bumping the version or emitting an event", async () => {
    const s = await setup();
    const task = await claimed(s, s.agent);
    await setLease(task.id, "clock_timestamp() + interval '1 minute'");
    const before = (
      await pool.query("SELECT count(*)::int AS c FROM events WHERE room_id = $1", [s.room])
    ).rows[0].c;
    const out = await heartbeat(s, s.agent, task.id);
    const lease = new Date(
      (out.response as { lease_expires_at: string }).lease_expires_at,
    ).getTime();
    expect(lease - Date.now()).toBeGreaterThan(14 * 60 * 1000);
    expect(out.events).toEqual([]);
    expect((await row(task.id)).version).toBe(task.version);
    const after = (
      await pool.query("SELECT count(*)::int AS c FROM events WHERE room_id = $1", [s.room])
    ).rows[0].c;
    expect(after).toBe(before);
  });

  it("works while IN_PROGRESS and BLOCKED too", async () => {
    const s = await setup();
    const task = await claimed(s, s.agent);
    const started = (await start(s, s.agent, task)).response as TaskView;
    await heartbeat(s, s.agent, task.id);
    await s.d.dispatch(
      s.agent,
      cmd("tasks.block", { task_id: task.id, expected_version: started.version, reason: "x" }),
    );
    await heartbeat(s, s.agent, task.id);
  });

  it("is a no-op for a human's claim (no lease to keep)", async () => {
    const s = await setup();
    const task = await claimed(s, s.human);
    const out = await heartbeat(s, s.human, task.id);
    expect(out.response).toEqual({ task_id: task.id, lease_expires_at: null });
  });

  it("only the owner can send one", async () => {
    const s = await setup();
    const task = await claimed(s, s.agent);
    for (const who of [s.agents[1]!, s.lead, s.owner, s.human]) {
      await rejects(heartbeat(s, who, task.id), "FORBIDDEN");
    }
  });

  it("has nothing to renew for an open, submitted or unknown task", async () => {
    const s = await setup();
    const open = (
      await s.d.dispatch(s.agent, cmd("tasks.create", { title: "T", requirements: ["r"] }))
    ).response as TaskView;
    await rejects(heartbeat(s, s.agent, open.id), "FORBIDDEN"); // nobody owns it
    const task = await claimed(s, s.agent);
    const started = (await start(s, s.agent, task)).response as TaskView;
    await submit(s, s.agent, started);
    await rejects(heartbeat(s, s.agent, task.id), "VALIDATION");
    await rejects(heartbeat(s, s.agent, "task_nope"), "NOT_FOUND");
  });

  it("any command by the owner on the task renews the lease: tasks.update too, but not someone else's", async () => {
    const s = await setup();
    const task = await claimed(s, s.agent);
    await setLease(task.id, "clock_timestamp() + interval '1 minute'");
    const byLead = (
      await s.d.dispatch(
        s.lead,
        cmd("tasks.update", { task_id: task.id, expected_version: task.version, priority: 1 }),
      )
    ).response as TaskView;
    expect(new Date(byLead.lease_expires_at!).getTime() - Date.now()).toBeLessThan(2 * 60 * 1000);
    const byOwner = (
      await s.d.dispatch(
        s.agent,
        cmd("tasks.update", { task_id: task.id, expected_version: byLead.version, priority: 0 }),
      )
    ).response as TaskView;
    expect(new Date(byOwner.lease_expires_at!).getTime() - Date.now()).toBeGreaterThan(
      14 * 60 * 1000,
    );
  });
});

describe("sweepExpiredLeases", () => {
  it("returns an expired, disconnected agent claim to OPEN with task.lease_expired", async () => {
    const s = await setup();
    const task = await claimed(s, s.agent);
    await expireAtT0(task.id);
    const swept = await sweepExpiredLeases(s.d, pool, { now: at(1) });
    expect(swept).toEqual([
      { room_id: s.room, task_id: task.id, previous_owner_id: s.agent.participant_id },
    ]);
    expect(await row(task.id)).toMatchObject({
      status: "OPEN",
      owner_id: null,
      lease_expires_at: null,
      version: task.version + 1,
    });
    const { rows } = await pool.query(
      "SELECT actor_id, payload FROM events WHERE room_id = $1 AND type = 'task.lease_expired'",
      [s.room],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: SYSTEM_ACTOR,
      payload: {
        task_id: task.id,
        previous_owner_id: s.agent.participant_id,
        version: task.version + 1,
      },
    });
    // And it can be claimed again.
    await claim(s, s.agents[1]!, { id: task.id, version: (await row(task.id)).version });
  });

  it("sweeps CLAIMED, IN_PROGRESS and BLOCKED tasks, and clears a block reason", async () => {
    const s = await setup();
    const a = await claimed(s, s.agent);
    const b = await claimed(s, s.agents[1]!);
    const bStarted = (await start(s, s.agents[1]!, b)).response as TaskView;
    const c = await claimed(s, s.agents[2]!);
    const cStarted = (await start(s, s.agents[2]!, c)).response as TaskView;
    await s.d.dispatch(
      s.agents[2]!,
      cmd("tasks.block", { task_id: c.id, expected_version: cStarted.version, reason: "stuck" }),
    );
    for (const t of [a, b, c]) await expireAtT0(t.id);
    const swept = await sweepExpiredLeases(s.d, pool, { now: at(1) });
    expect(swept.map((x) => x.task_id).sort()).toEqual([a.id, b.id, c.id].sort());
    for (const t of [a, b, c])
      expect(await row(t.id)).toMatchObject({ status: "OPEN", blocked_reason: null });
    void bStarted;
  });

  it("ignores human claims, however old", async () => {
    const s = await setup();
    const task = await claimed(s, s.human);
    await expireAtT0(task.id); // a lease a human could never have, forced
    expect(await sweepExpiredLeases(s.d, pool, { now: at(3600) })).toEqual([]);
    expect(await row(task.id)).toMatchObject({
      status: "CLAIMED",
      owner_id: s.human.participant_id,
    });
  });

  it("ignores unexpired leases, up to the instant they run out", async () => {
    const s = await setup();
    const task = await claimed(s, s.agent);
    await expireAtT0(task.id);
    expect(await sweepExpiredLeases(s.d, pool, { now: at(-1) })).toEqual([]);
    expect((await row(task.id)).status).toBe("CLAIMED");
    expect(await sweepExpiredLeases(s.d, pool, { now: at(0) })).toHaveLength(1); // expires_at <= now
  });

  it("ignores tasks in REVIEW and DONE, and open tasks", async () => {
    const s = await setup();
    const t = await claimed(s, s.agent);
    const started = (await start(s, s.agent, t)).response as TaskView;
    await submit(s, s.agent, started); // REVIEW, lease cleared
    const open = (
      await s.d.dispatch(s.agent, cmd("tasks.create", { title: "T", requirements: ["r"] }))
    ).response as TaskView;
    await setLease(t.id, `'${T0.toISOString()}'::timestamptz`); // even a stray lease is ignored in REVIEW
    expect(await sweepExpiredLeases(s.d, pool, { now: at(60) })).toEqual([]);
    expect((await row(t.id)).status).toBe("REVIEW");
    expect((await row(open.id)).status).toBe("OPEN");
  });

  it("leaves agents that are still connected alone", async () => {
    const s = await setup();
    const kept = await claimed(s, s.agent);
    const lost = await claimed(s, s.agents[1]!);
    await expireAtT0(kept.id);
    await expireAtT0(lost.id);
    const swept = await sweepExpiredLeases(s.d, pool, {
      now: at(1),
      isConnected: (id) => id === s.agent.participant_id,
    });
    expect(swept.map((x) => x.task_id)).toEqual([lost.id]);
    expect((await row(kept.id)).status).toBe("CLAIMED");
  });

  it("a heartbeat before the sweep saves the task; a second sweep finds nothing", async () => {
    const s = await setup();
    const task = await claimed(s, s.agent);
    await expireAtT0(task.id);
    await heartbeat(s, s.agent, task.id); // lease is now ~15 minutes from the real now
    expect(await sweepExpiredLeases(s.d, pool, { now: at(1) })).toEqual([]);
    const gone = await claimed(s, s.agents[1]!);
    await expireAtT0(gone.id);
    expect(await sweepExpiredLeases(s.d, pool, { now: at(1) })).toHaveLength(1);
    expect(await sweepExpiredLeases(s.d, pool, { now: at(1) })).toEqual([]);
  });

  it("sweeps only the rooms this node owns: each owner node sweeps its own", async () => {
    const s1 = await setup();
    const s2 = await setup();
    const t1 = await claimed(s1, s1.agent);
    const t2 = await claimed(s2, s2.agent);
    await expireAtT0(t1.id);
    await expireAtT0(t2.id);
    expect((await sweepExpiredLeases(s1.d, pool, { now: at(1) })).map((x) => x.task_id)).toEqual([
      t1.id,
    ]);
    expect((await row(t2.id)).status).toBe("CLAIMED"); // not s1's room
    expect((await sweepExpiredLeases(s2.d, pool, { now: at(1) })).map((x) => x.task_id)).toEqual([
      t2.id,
    ]);
    expect(await sweepExpiredLeases(s1.d, pool, { now: at(1), rooms: [] })).toEqual([]);
  });
});
