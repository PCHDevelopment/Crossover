import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerTaskCommands } from "./create-update.js";
import { registerTaskLifecycleCommands, type HealthGate } from "./lifecycle.js";
import { registerTaskReadCommands } from "./read.js";
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

async function setup(healthGate?: HealthGate) {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerTaskCommands(d);
  registerTaskReadCommands(d);
  registerTaskLifecycleCommands(d, healthGate ? { healthGate } : {});
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
const review = (
  s: Setup,
  who: Principal,
  task: Pick<TaskView, "id" | "version">,
  verdict: string,
) =>
  s.d.dispatch(
    who,
    cmd("tasks.review", { task_id: task.id, expected_version: task.version, verdict }),
  );
const call =
  (method: string) => (s: Setup, who: Principal, task: Pick<TaskView, "id" | "version">) =>
    s.d.dispatch(who, cmd(method, { task_id: task.id, expected_version: task.version }));
const release = call("tasks.release");
const reopen = call("tasks.reopen");
const cancel = call("tasks.cancel");
const unblock = call("tasks.unblock");
const block = (s: Setup, who: Principal, task: Pick<TaskView, "id" | "version">) =>
  s.d.dispatch(
    who,
    cmd("tasks.block", { task_id: task.id, expected_version: task.version, reason: "stuck" }),
  );

type State = "OPEN" | "CLAIMED" | "IN_PROGRESS" | "BLOCKED" | "REVIEW" | "DONE" | "CANCELLED";
/** A task in `state`, owned by `who` when it has an owner. */
async function inState(s: Setup, who: Principal, state: State): Promise<TaskView> {
  let t = (await s.d.dispatch(s.agent, cmd("tasks.create", { title: "T", requirements: ["r"] })))
    .response as TaskView;
  const steps: Record<string, () => Promise<void>> = {
    CLAIMED: async () => void (t = (await claim(s, who, t)).response as TaskView),
    IN_PROGRESS: async () => void (t = (await start(s, who, t)).response as TaskView),
    BLOCKED: async () => void (t = (await block(s, who, t)).response as TaskView),
    REVIEW: async () => {
      t = (await unblock(s, who, t)).response as TaskView;
      t = (await submit(s, who, t)).response as TaskView;
    },
    DONE: async () => void (t = (await review(s, s.lead, t, "approve")).response as TaskView),
  };
  const path: Record<State, State[]> = {
    OPEN: [],
    CLAIMED: ["CLAIMED"],
    IN_PROGRESS: ["CLAIMED", "IN_PROGRESS"],
    BLOCKED: ["CLAIMED", "IN_PROGRESS", "BLOCKED"],
    REVIEW: ["CLAIMED", "IN_PROGRESS", "BLOCKED", "REVIEW"],
    DONE: ["CLAIMED", "IN_PROGRESS", "BLOCKED", "REVIEW", "DONE"],
    CANCELLED: [],
  };
  for (const step of path[state]) await steps[step]!();
  if (state === "CANCELLED") t = (await cancel(s, s.lead, t)).response as TaskView;
  expect(t.status).toBe(state);
  return t;
}

describe("tasks.release", () => {
  it.each(["CLAIMED", "IN_PROGRESS", "BLOCKED"] as const)(
    "the owner releases a %s task back to OPEN: no owner, no lease, no block",
    async (state) => {
      const s = await setup();
      const task = await inState(s, s.agent, state);
      const out = await release(s, s.agent, task);
      expect(out.response).toMatchObject({
        status: "OPEN",
        owner_id: null,
        lease_expires_at: null,
        blocked_reason: null,
        version: task.version + 1,
      });
      expect(out.events[0]).toMatchObject({
        type: "task.released",
        payload: { task_id: task.id, previous_owner_id: s.agent.participant_id },
      });
      // And anyone can claim it again.
      await claim(s, s.human, out.response as TaskView);
    },
  );

  // Measured (T1529): idle n/a, 3x load 2413 ms; budget 7x.
  it("the lead, owner and admin can release someone else's task; other developers can't", async () => {
    const s = await setup();
    for (const who of [s.lead, s.owner, s.admin]) {
      const task = await inState(s, s.agent, "IN_PROGRESS");
      expect(((await release(s, who, task)).response as TaskView).status).toBe("OPEN");
    }
    const task = await inState(s, s.agent, "IN_PROGRESS");
    for (const who of [s.agents[1]!, s.human, s.reviewer, s.observer]) {
      await rejects(release(s, who, task), "FORBIDDEN");
    }
  }, 20_000);

  it.each(["OPEN", "REVIEW", "DONE", "CANCELLED"] as const)(
    "a %s task can't be released",
    async (state) => {
      const s = await setup();
      const task = await inState(s, s.agent, state);
      await rejects(release(s, s.lead, task), "VALIDATION");
    },
  );

  it("a stale version is CONFLICT_VERSION", async () => {
    const s = await setup();
    const task = await inState(s, s.agent, "CLAIMED");
    await release(s, s.agent, task);
    await rejects(release(s, s.lead, task), "CONFLICT_VERSION");
  });
});

describe("tasks.reopen", () => {
  // Measured (T1529): idle n/a, 3x load 2644 ms; budget 7x.
  it("the lead and owner reopen a DONE task: IN_PROGRESS with the same owner, and a fresh lease for an agent", async () => {
    const s = await setup();
    for (const who of [s.lead, s.owner, s.admin]) {
      const task = await inState(s, s.agent, "DONE");
      expect(task.lease_expires_at).toBeNull();
      const out = await reopen(s, who, task);
      const back = out.response as TaskView;
      expect(back).toMatchObject({
        status: "IN_PROGRESS",
        owner_id: s.agent.participant_id,
        version: task.version + 1,
      });
      expect(back.lease_expires_at).not.toBeNull();
      expect(out.events[0]).toMatchObject({ type: "task.reopened", actor_id: who.participant_id });
    }
  }, 20_000);

  it("developers, reviewers and observers → FORBIDDEN, even the task's own owner", async () => {
    const s = await setup();
    const task = await inState(s, s.agent, "DONE");
    for (const who of [s.agent, s.agents[1]!, s.human, s.reviewer, s.observer]) {
      await rejects(reopen(s, who, task), "FORBIDDEN");
    }
  });

  it.each(["OPEN", "CLAIMED", "IN_PROGRESS", "BLOCKED", "REVIEW", "CANCELLED"] as const)(
    "only DONE reopens, not %s",
    async (state) => {
      const s = await setup();
      await rejects(reopen(s, s.lead, await inState(s, s.agent, state)), "VALIDATION");
    },
  );
});

describe("tasks.cancel", () => {
  it.each(["OPEN", "CLAIMED", "IN_PROGRESS", "BLOCKED", "REVIEW"] as const)(
    "the lead cancels a %s task; the lease is cleared and the owner kept",
    async (state) => {
      const s = await setup();
      const task = await inState(s, s.agent, state);
      const out = await cancel(s, s.lead, task);
      expect(out.response).toMatchObject({
        status: "CANCELLED",
        lease_expires_at: null,
        owner_id: task.owner_id,
        version: task.version + 1,
      });
      expect(out.events[0]).toMatchObject({
        type: "task.cancelled",
        payload: { task_id: task.id, previous_status: state },
      });
    },
  );

  it("cancel on a DONE task → VALIDATION, and a cancelled task can't be cancelled again", async () => {
    const s = await setup();
    const done = await inState(s, s.agent, "DONE");
    const err = await rejects(cancel(s, s.lead, done), "VALIDATION");
    expect(err.details).toMatchObject({ status: "DONE" });
    const cancelled = await inState(s, s.agent, "CANCELLED");
    await rejects(cancel(s, s.lead, cancelled), "VALIDATION");
  });

  it("only the lead, owner and admin; the task's own developer can't cancel it", async () => {
    const s = await setup();
    const task = await inState(s, s.agent, "IN_PROGRESS");
    for (const who of [s.agent, s.agents[1]!, s.human, s.reviewer, s.observer]) {
      await rejects(cancel(s, who, task), "FORBIDDEN");
    }
    for (const who of [s.owner, s.admin]) {
      expect(
        ((await cancel(s, who, await inState(s, s.agent, "OPEN"))).response as TaskView).status,
      ).toBe("CANCELLED");
    }
  });

  it("a cancelled task can't be claimed, started or updated", async () => {
    const s = await setup();
    const task = await inState(s, s.agent, "CANCELLED");
    await rejects(claim(s, s.human, task), "CONFLICT_VERSION");
    await rejects(
      s.d.dispatch(
        s.lead,
        cmd("tasks.update", { task_id: task.id, expected_version: task.version, title: "x" }),
      ),
      "VALIDATION",
    );
  });
});
