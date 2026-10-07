import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerTaskCommands } from "./create-update.js";
import { AGENT_LEASE_MINUTES, registerTaskLifecycleCommands } from "./lifecycle.js";
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
  const room = newId("room");
  const ownerId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', $2)`,
    [room, ownerId],
  );
  const agents = [];
  for (let i = 0; i < 10; i++) agents.push(await add(room, "DEVELOPER", "AGENT"));
  return {
    d,
    room,
    agents,
    agent: agents[0]!,
    human: await add(room, "DEVELOPER", "HUMAN"),
    reviewer: await add(room, "REVIEWER", "AGENT"),
    observer: await add(room, "OBSERVER", "AGENT"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const mk = async (s: Setup) =>
  (await s.d.dispatch(s.agent, cmd("tasks.create", { title: "T", requirements: ["r"] })))
    .response as TaskView;
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

describe("tasks.claim", () => {
  it("OPEN → CLAIMED for the caller, version + 1, and emits task.claimed", async () => {
    const s = await setup();
    const task = await mk(s);
    const out = await claim(s, s.human, task);
    expect(out.response).toMatchObject({
      id: task.id,
      status: "CLAIMED",
      owner_id: s.human.participant_id,
      version: 2,
    });
    expect(out.events[0]).toMatchObject({
      type: "task.claimed",
      actor_id: s.human.participant_id,
      payload: { task_id: task.id, owner_id: s.human.participant_id, from_version: 1, version: 2 },
    });
  });

  it("gives an agent a 15-minute lease and a human none", async () => {
    const s = await setup();
    const a = (await claim(s, s.agent, await mk(s))).response as TaskView;
    const left = new Date(a.lease_expires_at!).getTime() - Date.now();
    expect(left).toBeGreaterThan((AGENT_LEASE_MINUTES * 60 - 10) * 1000);
    expect(left).toBeLessThanOrEqual(AGENT_LEASE_MINUTES * 60 * 1000);
    const h = (await claim(s, s.human, await mk(s))).response as TaskView;
    expect(h.lease_expires_at).toBeNull();
  });

  it("10 concurrent claimants: exactly one wins, the rest get CONFLICT_VERSION with the current task", async () => {
    const s = await setup();
    const task = await mk(s);
    const results = await Promise.allSettled(s.agents.map((who) => claim(s, who, task)));
    const wins = results.flatMap((r, i) => (r.status === "fulfilled" ? [i] : []));
    expect(wins).toHaveLength(1);
    const winner = s.agents[wins[0]!]!.participant_id;
    for (const r of results) {
      if (r.status !== "rejected") continue;
      const err = r.reason as CrossoverError;
      expect(err.code).toBe("CONFLICT_VERSION");
      expect(err.details).toMatchObject({
        current: { id: task.id, status: "CLAIMED", owner_id: winner, version: 2 },
      });
    }
    const { rows } = await pool.query("SELECT owner_id, version FROM tasks WHERE id = $1", [
      task.id,
    ]);
    expect(rows[0]).toEqual({ owner_id: winner, version: 2 });
    const events = await pool.query(
      "SELECT 1 FROM events WHERE room_id = $1 AND type = 'task.claimed'",
      [s.room],
    );
    expect(events.rows).toHaveLength(1);
  });

  it("a later claimant of a claimed task gets CONFLICT_VERSION, even with the new version", async () => {
    const s = await setup();
    const task = await mk(s);
    await claim(s, s.agents[0]!, task);
    await rejects(claim(s, s.agents[1]!, task), "CONFLICT_VERSION");
    const err = await rejects(
      claim(s, s.agents[1]!, { id: task.id, version: 2 }),
      "CONFLICT_VERSION",
    );
    expect(err.details).toMatchObject({ current: { owner_id: s.agents[0]!.participant_id } });
  });

  it("a stale version on an open task is CONFLICT_VERSION", async () => {
    const s = await setup();
    const task = await mk(s);
    await s.d.dispatch(
      s.agent,
      cmd("tasks.update", { task_id: task.id, expected_version: 1, title: "New" }),
    );
    const err = await rejects(claim(s, s.human, task), "CONFLICT_VERSION");
    expect(err.details).toMatchObject({ current: { title: "New", version: 2, status: "OPEN" } });
  });

  it("is for roles with tasks.claim (not reviewers or observers)", async () => {
    const s = await setup();
    const task = await mk(s);
    for (const who of [s.reviewer, s.observer]) await rejects(claim(s, who, task), "FORBIDDEN");
    const { rows } = await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id]);
    expect(rows[0].status).toBe("OPEN");
  });

  it("answers NOT_FOUND for an unknown task or another room's", async () => {
    const s = await setup();
    const other = await setup();
    const foreign = await mk(other);
    await rejects(claim(s, s.human, foreign), "NOT_FOUND");
    await rejects(claim(s, s.human, { id: "task_nope", version: 1 }), "NOT_FOUND");
  });

  it("is idempotent per key", async () => {
    const s = await setup();
    const task = await mk(s);
    const envelope = cmd("tasks.claim", { task_id: task.id, expected_version: 1 });
    const a = await s.d.dispatch(s.human, envelope);
    const b = await s.d.dispatch(s.human, envelope);
    expect(b.replayed).toBe(true);
    expect(b.response).toEqual(a.response);
  });
});
