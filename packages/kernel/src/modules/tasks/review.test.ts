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
  extra: Record<string, unknown>,
) =>
  s.d.dispatch(
    who,
    cmd("tasks.review", { task_id: task.id, expected_version: task.version, ...extra }),
  );
/** A task in REVIEW, owned by `who`, with `reviewer` named (or nobody). */
const inReview = async (s: Setup, who: Principal, reviewer?: Principal) => {
  const t = (
    await s.d.dispatch(
      s.agent,
      cmd("tasks.create", {
        title: "T",
        requirements: ["r"],
        ...(reviewer ? { reviewer_id: reviewer.participant_id } : {}),
      }),
    )
  ).response as TaskView;
  const c = (await claim(s, who, t)).response as TaskView;
  const r = (await start(s, who, c)).response as TaskView;
  return (await submit(s, who, r)).response as TaskView;
};
const reviews = async (taskId: string) =>
  (
    await pool.query(
      "SELECT reviewer_id, verdict, comments, revision FROM task_reviews WHERE task_id = $1 ORDER BY created_at",
      [taskId],
    )
  ).rows;

describe("tasks.review", () => {
  it("the named reviewer approves: REVIEW → DONE, a review is recorded, task.reviewed is emitted", async () => {
    const s = await setup();
    const task = await inReview(s, s.agent, s.reviewer);
    const out = await review(s, s.reviewer, task, { verdict: "approve", comments: "looks right" });
    expect(out.response).toMatchObject({
      status: "DONE",
      version: task.version + 1,
      lease_expires_at: null,
    });
    expect(out.events[0]).toMatchObject({
      type: "task.reviewed",
      actor_id: s.reviewer.participant_id,
      payload: {
        task_id: task.id,
        verdict: "approve",
        status: "DONE",
        reviewer_id: s.reviewer.participant_id,
      },
    });
    expect(await reviews(task.id)).toEqual([
      {
        reviewer_id: s.reviewer.participant_id,
        verdict: "APPROVE",
        comments: "looks right",
        revision: "0",
      },
    ]);
  });

  it("request_changes sends it back to IN_PROGRESS and restarts the owner's lease", async () => {
    const s = await setup();
    const task = await inReview(s, s.agent, s.reviewer);
    const out = await review(s, s.reviewer, task, {
      verdict: "request_changes",
      comments: "add tests",
    });
    const back = out.response as TaskView;
    expect(back).toMatchObject({ status: "IN_PROGRESS", owner_id: s.agent.participant_id });
    expect(back.lease_expires_at).not.toBeNull();
    expect((await reviews(task.id))[0]).toMatchObject({
      verdict: "REQUEST_CHANGES",
      comments: "add tests",
    });
    // Another round: resubmit and approve; both reviews are kept, newest last.
    const again = (await submit(s, s.agent, back)).response as TaskView;
    await review(s, s.reviewer, again, { verdict: "approve" });
    expect((await reviews(task.id)).map((r) => r.verdict)).toEqual(["REQUEST_CHANGES", "APPROVE"]);
    const got = (
      await s.d.dispatch(s.observer, {
        id: newId("cmd"),
        method: "tasks.get",
        params: { task_id: task.id },
      })
    ).response as { reviews: unknown[] };
    expect(got.reviews).toHaveLength(2);
  });

  it("records the workspace revision that was reviewed", async () => {
    const s = await setup();
    await pool.query("INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, '/tmp/x')", [
      "ws_" + s.room,
      s.room,
    ]);
    for (const revision of [0, 1, 2, 3]) {
      await pool.query(
        "INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha) VALUES ($1, $2, $3, 'abc')",
        ["ws_" + s.room, s.room, revision],
      );
    }
    const task = await inReview(s, s.agent, s.reviewer);
    await review(s, s.reviewer, task, { verdict: "approve" });
    expect((await reviews(task.id))[0]!.revision).toBe("3");
  });

  it("with no reviewer named, the lead (or project owner/admin) reviews; other reviewers can't", async () => {
    const s = await setup();
    const task = await inReview(s, s.agent);
    await rejects(review(s, s.reviewer, task, { verdict: "approve" }), "FORBIDDEN");
    await rejects(review(s, s.agents[1]!, task, { verdict: "approve" }), "FORBIDDEN");
    await rejects(review(s, s.observer, task, { verdict: "approve" }), "FORBIDDEN");
    expect(
      ((await review(s, s.lead, task, { verdict: "approve" })).response as TaskView).status,
    ).toBe("DONE");
  });

  it("the lead can review a task another reviewer was named for", async () => {
    const s = await setup();
    const task = await inReview(s, s.agent, s.reviewer);
    await review(s, s.lead, task, { verdict: "request_changes" });
    expect((await reviews(task.id))[0]!.reviewer_id).toBe(s.lead.participant_id);
  });

  it("nobody approves their own task: the owner of the task, even as lead or named reviewer", async () => {
    const s = await setup();
    // The lead owns the task and is also named its reviewer.
    const own = await inReview(s, s.lead, s.lead);
    for (const verdict of ["approve", "request_changes"]) {
      const err = await rejects(review(s, s.lead, own, { verdict }), "FORBIDDEN");
      expect(err.details).toMatchObject({ reason: "own_task" });
    }
    // The project owner owning a task can't approve it either.
    const mine = await inReview(s, s.owner);
    await rejects(review(s, s.owner, mine, { verdict: "approve" }), "FORBIDDEN");
    const { rows } = await pool.query("SELECT status FROM tasks WHERE id = $1", [own.id]);
    expect(rows[0].status).toBe("REVIEW");
    expect(await reviews(own.id)).toEqual([]);
  });

  describe("the health gate", () => {
    const gate = (green: boolean) => {
      const calls: string[] = [];
      const healthGate: HealthGate = {
        isGreenFor: async (task) => {
          calls.push(task.id);
          return green;
        },
      };
      return { healthGate, calls };
    };

    it("a red gate → VALIDATION, and the task stays in REVIEW with no review recorded", async () => {
      const g = gate(false);
      const s = await setup(g.healthGate);
      const task = await inReview(s, s.agent, s.reviewer);
      const err = await rejects(review(s, s.reviewer, task, { verdict: "approve" }), "VALIDATION");
      expect(err.details).toMatchObject({ reason: "health_gate_red" });
      expect(g.calls).toEqual([task.id]);
      expect(await reviews(task.id)).toEqual([]);
      const { rows } = await pool.query("SELECT status FROM tasks WHERE id = $1", [task.id]);
      expect(rows[0].status).toBe("REVIEW");
    });

    it("the lead can override a red gate, and the event says so", async () => {
      const g = gate(false);
      const s = await setup(g.healthGate);
      const task = await inReview(s, s.agent, s.reviewer);
      const out = await review(s, s.lead, task, { verdict: "approve", override_health: true });
      expect((out.response as TaskView).status).toBe("DONE");
      expect(out.events[0]).toMatchObject({ payload: { health_overridden: true } });
    });

    it("the named reviewer can't override it", async () => {
      const s = await setup(gate(false).healthGate);
      const task = await inReview(s, s.agent, s.reviewer);
      await rejects(
        review(s, s.reviewer, task, { verdict: "approve", override_health: true }),
        "FORBIDDEN",
      );
    });

    // Measured (T1529): idle n/a, 3x load 3203 ms; budget 7x.
    it("a green gate approves; request_changes doesn't consult the gate; the default is always green", async () => {
      const g = gate(true);
      const s = await setup(g.healthGate);
      const t1 = await inReview(s, s.agent, s.reviewer);
      await review(s, s.reviewer, t1, { verdict: "approve" });
      const t2 = await inReview(s, s.agent, s.reviewer);
      await review(s, s.reviewer, t2, { verdict: "request_changes" });
      expect(g.calls).toEqual([t1.id]);
      const red = gate(false);
      const s2 = await setup(red.healthGate);
      const t3 = await inReview(s2, s2.agent, s2.reviewer);
      await review(s2, s2.reviewer, t3, { verdict: "request_changes" });
      expect(red.calls).toEqual([]);
      const s3 = await setup();
      const t4 = await inReview(s3, s3.agent, s3.reviewer);
      await review(s3, s3.reviewer, t4, { verdict: "approve" });
    }, 25_000);
  });

  it("only reviews a task in REVIEW; a stale version is CONFLICT_VERSION", async () => {
    const s = await setup();
    const t = (
      await s.d.dispatch(s.agent, cmd("tasks.create", { title: "T", requirements: ["r"] }))
    ).response as TaskView;
    await rejects(review(s, s.lead, t, { verdict: "approve" }), "VALIDATION"); // OPEN
    const task = await inReview(s, s.agent, s.reviewer);
    const done = (await review(s, s.reviewer, task, { verdict: "approve" })).response as TaskView;
    await rejects(review(s, s.reviewer, done, { verdict: "approve" }), "VALIDATION");
    const err = await rejects(
      review(s, s.reviewer, task, { verdict: "approve" }),
      "CONFLICT_VERSION",
    );
    expect(err.details).toMatchObject({ current: { status: "DONE" } });
  });

  it("validates its input and answers NOT_FOUND for an unknown task", async () => {
    const s = await setup();
    const task = await inReview(s, s.agent, s.reviewer);
    for (const extra of [{}, { verdict: "maybe" }, { verdict: "approve", comments: 5 }]) {
      await rejects(review(s, s.reviewer, task, extra), "VALIDATION");
    }
    await rejects(
      review(s, s.lead, { id: "task_nope", version: 1 }, { verdict: "approve" }),
      "NOT_FOUND",
    );
  });
});
