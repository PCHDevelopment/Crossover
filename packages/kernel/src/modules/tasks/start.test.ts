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
const mkWith = async (s: Setup, extra: Record<string, unknown>) =>
  (await s.d.dispatch(s.agent, cmd("tasks.create", { title: "T", requirements: ["r"], ...extra })))
    .response as TaskView;
const claimed = async (s: Setup, who: Principal, extra: Record<string, unknown> = {}) => {
  const task = await mkWith(s, extra);
  return (await claim(s, who, task)).response as TaskView;
};
const setStatus = (id: string, status: string) =>
  pool.query("UPDATE tasks SET status = $2 WHERE id = $1", [id, status]);

describe("tasks.start", () => {
  it("CLAIMED → IN_PROGRESS for the task's owner, version + 1, emits task.started", async () => {
    const s = await setup();
    const task = await claimed(s, s.human);
    const out = await start(s, s.human, task);
    expect(out.response).toMatchObject({
      status: "IN_PROGRESS",
      owner_id: s.human.participant_id,
      version: 3,
    });
    expect(out.events[0]).toMatchObject({
      type: "task.started",
      actor_id: s.human.participant_id,
      payload: { task_id: task.id, from_version: 2, version: 3 },
    });
  });

  it("renews an agent owner's lease and leaves a human's empty", async () => {
    const s = await setup();
    const a = await claimed(s, s.agent);
    await pool.query(
      "UPDATE tasks SET lease_expires_at = clock_timestamp() + interval '1 minute' WHERE id = $1",
      [a.id],
    );
    const started = (await start(s, s.agent, a)).response as TaskView;
    expect(new Date(started.lease_expires_at!).getTime() - Date.now()).toBeGreaterThan(
      10 * 60 * 1000,
    );
    const h = (await start(s, s.human, await claimed(s, s.human))).response as TaskView;
    expect(h.lease_expires_at).toBeNull();
  });

  it("only the task's owner: everyone else is FORBIDDEN, the lead and owner included", async () => {
    const s = await setup();
    const task = await claimed(s, s.agent);
    for (const who of [s.agents[1]!, s.lead, s.owner, s.admin, s.human, s.observer]) {
      await rejects(start(s, who, task), "FORBIDDEN");
    }
    const { rows } = await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id]);
    expect(rows[0].status).toBe("CLAIMED");
  });

  it("an open task (nobody owns it) can't be started", async () => {
    const s = await setup();
    await rejects(start(s, s.agent, await mkWith(s, {})), "FORBIDDEN");
  });

  it("a stale version is CONFLICT_VERSION; a current one on a started task is VALIDATION", async () => {
    const s = await setup();
    const task = await claimed(s, s.agent);
    const started = (await start(s, s.agent, task)).response as TaskView;
    const err = await rejects(start(s, s.agent, task), "CONFLICT_VERSION");
    expect(err.details).toMatchObject({ current: { status: "IN_PROGRESS" } });
    await rejects(start(s, s.agent, started), "VALIDATION");
  });

  describe("dependencies", () => {
    it("an unfinished dependency → VALIDATION naming it", async () => {
      const s = await setup();
      const dep = await mkWith(s, {});
      const task = await claimed(s, s.agent, { dependencies: [dep.id] });
      const err = await rejects(start(s, s.agent, task), "VALIDATION");
      expect(err.message).toContain(dep.id);
      expect(err.details).toMatchObject({
        unfinished_dependencies: [{ id: dep.id, status: "OPEN" }],
      });
      const { rows } = await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id]);
      expect(rows[0].status).toBe("CLAIMED");
    });

    it("names every unfinished dependency, whatever its state, and a cancelled one still blocks", async () => {
      const s = await setup();
      const a = await mkWith(s, {});
      const b = await mkWith(s, {});
      const c = await mkWith(s, {});
      await setStatus(b.id, "CANCELLED");
      await pool.query("UPDATE tasks SET status = 'DONE', owner_id = $2 WHERE id = $1", [
        c.id,
        s.human.participant_id,
      ]);
      const task = await claimed(s, s.agent, { dependencies: [a.id, b.id, c.id] });
      const err = await rejects(start(s, s.agent, task), "VALIDATION");
      expect(
        (err.details as { unfinished_dependencies: { id: string }[] }).unfinished_dependencies
          .map((d) => d.id)
          .sort(),
      ).toEqual([a.id, b.id].sort());
    });

    it("starts once every dependency is DONE", async () => {
      const s = await setup();
      const dep = await mkWith(s, {});
      const task = await claimed(s, s.agent, { dependencies: [dep.id] });
      await pool.query("UPDATE tasks SET status = 'DONE', owner_id = $2 WHERE id = $1", [
        dep.id,
        s.human.participant_id,
      ]);
      expect(((await start(s, s.agent, task)).response as TaskView).status).toBe("IN_PROGRESS");
    });

    it("starts despite unfinished dependencies when the lead set override_dependencies", async () => {
      const s = await setup();
      const dep = await mkWith(s, {});
      const task = await claimed(s, s.agent, { dependencies: [dep.id] });
      await rejects(start(s, s.agent, task), "VALIDATION");
      const overridden = (
        await s.d.dispatch(
          s.lead,
          cmd("tasks.update", {
            task_id: task.id,
            expected_version: task.version,
            override_dependencies: true,
          }),
        )
      ).response as TaskView;
      expect(((await start(s, s.agent, overridden)).response as TaskView).status).toBe(
        "IN_PROGRESS",
      );
    });
  });

  it("answers NOT_FOUND for an unknown task", async () => {
    const s = await setup();
    await rejects(start(s, s.agent, { id: "task_nope", version: 1 }), "NOT_FOUND");
  });
});
