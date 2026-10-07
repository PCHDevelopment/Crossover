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

const assign = (s: Setup, who: Principal, task: Pick<TaskView, "id" | "version">, to: Principal) =>
  s.d.dispatch(
    who,
    cmd("tasks.assign", {
      task_id: task.id,
      expected_version: task.version,
      participant_id: to.participant_id,
    }),
  );

describe("tasks.assign", () => {
  it("lets the lead, owner and admin assign an open task; emits task.assigned", async () => {
    const s = await setup();
    for (const who of [s.lead, s.owner, s.admin]) {
      const task = await mk(s);
      const out = await assign(s, who, task, s.human);
      expect(out.response).toMatchObject({
        status: "CLAIMED",
        owner_id: s.human.participant_id,
        version: 2,
      });
      expect(out.events[0]).toMatchObject({
        type: "task.assigned",
        actor_id: who.participant_id,
        payload: {
          task_id: task.id,
          owner_id: s.human.participant_id,
          assigned_by: who.participant_id,
          from_version: 1,
          version: 2,
        },
      });
    }
  });

  it("a developer calling assign → FORBIDDEN, and so are reviewers and observers", async () => {
    const s = await setup();
    const task = await mk(s);
    for (const who of [s.agent, s.human, s.reviewer, s.observer]) {
      await rejects(assign(s, who, task, s.agents[1]!), "FORBIDDEN");
    }
    const { rows } = await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id]);
    expect(rows[0].status).toBe("OPEN");
  });

  it("gives an agent assignee a lease and a human none", async () => {
    const s = await setup();
    const a = (await assign(s, s.lead, await mk(s), s.agents[1]!)).response as TaskView;
    expect(a.lease_expires_at).not.toBeNull();
    const h = (await assign(s, s.lead, await mk(s), s.human)).response as TaskView;
    expect(h.lease_expires_at).toBeNull();
  });

  it("only assigns an OPEN task at the version seen: CONFLICT_VERSION otherwise", async () => {
    const s = await setup();
    const task = await mk(s);
    await assign(s, s.lead, task, s.human);
    const err = await rejects(assign(s, s.lead, task, s.agents[1]!), "CONFLICT_VERSION");
    expect(err.details).toMatchObject({ current: { owner_id: s.human.participant_id } });
  });

  it("a claim and an assign racing for one task: exactly one wins", async () => {
    const s = await setup();
    const task = await mk(s);
    const results = await Promise.allSettled([
      claim(s, s.agents[1]!, task),
      assign(s, s.lead, task, s.agents[2]!),
      claim(s, s.human, task),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected")
        expect((r.reason as CrossoverError).code).toBe("CONFLICT_VERSION");
    }
  });

  it("the assignee must be an active participant of the room", async () => {
    const s = await setup();
    const other = await setup();
    const task = await mk(s);
    await rejects(assign(s, s.lead, task, other.agent), "NOT_FOUND");
    for (const status of ["PAUSED", "INVITED", "REMOVED"]) {
      const p = await add(s.room, "DEVELOPER", "AGENT");
      await pool.query("UPDATE participants SET status = $2 WHERE id = $1", [
        p.participant_id,
        status,
      ]);
      await rejects(assign(s, s.lead, task, p), "VALIDATION");
    }
    const { rows } = await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id]);
    expect(rows[0].status).toBe("OPEN");
  });

  it("answers NOT_FOUND for an unknown task", async () => {
    const s = await setup();
    await rejects(assign(s, s.lead, { id: "task_nope", version: 1 }, s.human), "NOT_FOUND");
  });
});
