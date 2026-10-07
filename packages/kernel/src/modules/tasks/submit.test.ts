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
const submit = (s: Setup, who: Principal, task: Pick<TaskView, "id" | "version">) =>
  s.d.dispatch(who, cmd("tasks.submit", { task_id: task.id, expected_version: task.version }));
const running = async (s: Setup, who: Principal, extra: Record<string, unknown> = {}) => {
  const t = (
    await s.d.dispatch(s.agent, cmd("tasks.create", { title: "T", requirements: ["r"], ...extra }))
  ).response as TaskView;
  const c = (await claim(s, who, t)).response as TaskView;
  return (await start(s, who, c)).response as TaskView;
};

describe("tasks.submit", () => {
  it("IN_PROGRESS → REVIEW for the owner when review is required, and emits task.submitted", async () => {
    const s = await setup();
    const task = await running(s, s.human);
    const out = await submit(s, s.human, task);
    expect(out.response).toMatchObject({
      status: "REVIEW",
      owner_id: s.human.participant_id,
      version: task.version + 1,
    });
    expect(out.events[0]).toMatchObject({
      type: "task.submitted",
      actor_id: s.human.participant_id,
      payload: { task_id: task.id, status: "REVIEW", review_required: true },
    });
  });

  it("goes straight to DONE when review_required is false", async () => {
    const s = await setup();
    const task = await running(s, s.human, { review_required: false });
    const out = await submit(s, s.human, task);
    expect(out.response).toMatchObject({ status: "DONE" });
    expect(out.events[0]).toMatchObject({ payload: { status: "DONE", review_required: false } });
  });

  it("a non-owner submit → FORBIDDEN (the lead and owner included)", async () => {
    const s = await setup();
    const task = await running(s, s.agent);
    for (const who of [s.agents[1]!, s.lead, s.owner, s.admin, s.human, s.reviewer, s.observer]) {
      await rejects(submit(s, who, task), "FORBIDDEN");
    }
    const { rows } = await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id]);
    expect(rows[0].status).toBe("IN_PROGRESS");
  });

  it("clears an agent's lease: a task awaiting review or done no longer expires", async () => {
    const s = await setup();
    const a = await running(s, s.agent);
    expect(a.lease_expires_at).not.toBeNull();
    expect(((await submit(s, s.agent, a)).response as TaskView).lease_expires_at).toBeNull();
    const b = await running(s, s.agent, { review_required: false });
    expect(((await submit(s, s.agent, b)).response as TaskView).lease_expires_at).toBeNull();
  });

  it("only submits an IN_PROGRESS task: CLAIMED, BLOCKED and already submitted are VALIDATION", async () => {
    const s = await setup();
    const t = (
      await s.d.dispatch(s.agent, cmd("tasks.create", { title: "T", requirements: ["r"] }))
    ).response as TaskView;
    const claimedTask = (await claim(s, s.human, t)).response as TaskView;
    await rejects(submit(s, s.human, claimedTask), "VALIDATION");
    const r = (await start(s, s.human, claimedTask)).response as TaskView;
    const b = (
      await s.d.dispatch(
        s.human,
        cmd("tasks.block", { task_id: r.id, expected_version: r.version, reason: "x" }),
      )
    ).response as TaskView;
    await rejects(submit(s, s.human, b), "VALIDATION");
    const u = (
      await s.d.dispatch(
        s.human,
        cmd("tasks.unblock", { task_id: b.id, expected_version: b.version }),
      )
    ).response as TaskView;
    const done = (await submit(s, s.human, u)).response as TaskView;
    await rejects(submit(s, s.human, done), "VALIDATION");
  });

  it("a stale version is CONFLICT_VERSION with the current task", async () => {
    const s = await setup();
    const task = await running(s, s.human);
    await submit(s, s.human, task);
    const err = await rejects(submit(s, s.human, task), "CONFLICT_VERSION");
    expect(err.details).toMatchObject({ current: { status: "REVIEW" } });
  });

  it("answers NOT_FOUND for an unknown task", async () => {
    const s = await setup();
    await rejects(submit(s, s.human, { id: "task_nope", version: 1 }), "NOT_FOUND");
  });
});
