import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerTaskCommands } from "./create-update.js";
import { registerTaskLifecycleCommands } from "./lifecycle.js";
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
const block = (
  s: Setup,
  who: Principal,
  task: Pick<TaskView, "id" | "version">,
  reason?: unknown,
) =>
  s.d.dispatch(
    who,
    cmd("tasks.block", {
      task_id: task.id,
      expected_version: task.version,
      ...(reason === undefined ? {} : { reason }),
    }),
  );
const unblock = (s: Setup, who: Principal, task: Pick<TaskView, "id" | "version">) =>
  s.d.dispatch(who, cmd("tasks.unblock", { task_id: task.id, expected_version: task.version }));
const running = async (s: Setup, who: Principal) => {
  const t = (await s.d.dispatch(s.agent, cmd("tasks.create", { title: "T", requirements: ["r"] })))
    .response as TaskView;
  const c = (await claim(s, who, t)).response as TaskView;
  return (await start(s, who, c)).response as TaskView;
};

describe("tasks.block / tasks.unblock", () => {
  it("the owner blocks an in-progress task with a reason, and unblocks it", async () => {
    const s = await setup();
    const task = await running(s, s.human);
    const blocked = await block(s, s.human, task, "waiting for the API key");
    expect(blocked.response).toMatchObject({
      status: "BLOCKED",
      blocked_reason: "waiting for the API key",
      version: task.version + 1,
    });
    expect(blocked.events[0]).toMatchObject({
      type: "task.blocked",
      payload: { task_id: task.id, reason: "waiting for the API key" },
    });
    const free = await unblock(s, s.human, blocked.response as TaskView);
    expect(free.response).toMatchObject({
      status: "IN_PROGRESS",
      blocked_reason: null,
      version: task.version + 2,
    });
    expect(free.events[0]).toMatchObject({ type: "task.unblocked", payload: { task_id: task.id } });
  });

  it("block without a reason → VALIDATION (missing, empty, blank)", async () => {
    const s = await setup();
    const task = await running(s, s.human);
    for (const reason of [undefined, "", "   ", 5]) {
      await rejects(block(s, s.human, task, reason), "VALIDATION");
    }
    const { rows } = await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id]);
    expect(rows[0].status).toBe("IN_PROGRESS");
  });

  it("lets the lead (and owner, admin) block and unblock someone else's task", async () => {
    const s = await setup();
    let task = await running(s, s.agent);
    for (const who of [s.lead, s.owner, s.admin]) {
      const b = (await block(s, who, task, `by ${who.role}`)).response as TaskView;
      expect(b.status).toBe("BLOCKED");
      task = (await unblock(s, who, b)).response as TaskView;
      expect(task.status).toBe("IN_PROGRESS");
    }
  });

  it("other developers, reviewers and observers are FORBIDDEN", async () => {
    const s = await setup();
    const task = await running(s, s.agent);
    for (const who of [s.agents[1]!, s.human, s.reviewer, s.observer]) {
      await rejects(block(s, who, task, "no"), "FORBIDDEN");
    }
    const blocked = (await block(s, s.agent, task, "stuck")).response as TaskView;
    for (const who of [s.agents[1]!, s.human]) await rejects(unblock(s, who, blocked), "FORBIDDEN");
  });

  it("only blocks IN_PROGRESS and only unblocks BLOCKED", async () => {
    const s = await setup();
    const t = (
      await s.d.dispatch(s.agent, cmd("tasks.create", { title: "T", requirements: ["r"] }))
    ).response as TaskView;
    const c = (await claim(s, s.agent, t)).response as TaskView;
    await rejects(block(s, s.agent, c, "x"), "VALIDATION"); // CLAIMED
    const r = (await start(s, s.agent, c)).response as TaskView;
    await rejects(unblock(s, s.agent, r), "VALIDATION"); // IN_PROGRESS
    const b = (await block(s, s.agent, r, "x")).response as TaskView;
    await rejects(block(s, s.agent, b, "again"), "VALIDATION"); // already BLOCKED
  });

  it("a stale version is CONFLICT_VERSION", async () => {
    const s = await setup();
    const task = await running(s, s.human);
    await block(s, s.human, task, "x");
    const err = await rejects(block(s, s.human, task, "y"), "CONFLICT_VERSION");
    expect(err.details).toMatchObject({ current: { status: "BLOCKED", blocked_reason: "x" } });
  });

  it("the owner's actions renew an agent's lease; the lead's don't", async () => {
    const s = await setup();
    const task = await running(s, s.agent);
    const old = "clock_timestamp() + interval '2 minutes'";
    await pool.query(`UPDATE tasks SET lease_expires_at = ${old} WHERE id = $1`, [task.id]);
    const byLead = (await block(s, s.lead, task, "pause")).response as TaskView;
    expect(new Date(byLead.lease_expires_at!).getTime() - Date.now()).toBeLessThan(3 * 60 * 1000);
    const byOwner = (await unblock(s, s.agent, byLead)).response as TaskView;
    expect(new Date(byOwner.lease_expires_at!).getTime() - Date.now()).toBeGreaterThan(
      10 * 60 * 1000,
    );
  });

  it("answers NOT_FOUND for an unknown task", async () => {
    const s = await setup();
    await rejects(block(s, s.lead, { id: "task_nope", version: 1 }, "x"), "NOT_FOUND");
    await rejects(unblock(s, s.lead, { id: "task_nope", version: 1 }), "NOT_FOUND");
  });
});
