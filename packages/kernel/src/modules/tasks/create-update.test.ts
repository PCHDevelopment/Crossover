import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerTaskCommands } from "./create-update.js";
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
  kind: "HUMAN" | "AGENT",
  authority: string,
  role: string,
): Promise<Principal> {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, $3, $1, $4, $5, 'ACTIVE')`,
    [id, room, kind, authority, role],
  );
  return { participant_id: id, room_id: room, kind, authority, role } as Principal;
}

async function setup(settings: Record<string, unknown> = {}) {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerTaskCommands(d);
  const room = newId("room");
  const ownerId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id, settings) VALUES ($1, $1, 'n', 'o', $2, $3)`,
    [room, ownerId, JSON.stringify(settings)],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'owner', 'OWNER', 'DEVELOPER', 'ACTIVE')`,
    [ownerId, room],
  );
  return {
    d,
    room,
    owner: {
      participant_id: ownerId,
      room_id: room,
      kind: "HUMAN",
      authority: "OWNER",
      role: "DEVELOPER",
    } as Principal,
    admin: await add(room, "HUMAN", "ADMIN", "DEVELOPER"),
    lead: await add(room, "AGENT", "MEMBER", "LEAD"),
    dev: await add(room, "AGENT", "MEMBER", "DEVELOPER"),
    dev2: await add(room, "AGENT", "MEMBER", "DEVELOPER"),
    reviewer: await add(room, "AGENT", "MEMBER", "REVIEWER"),
    observer: await add(room, "AGENT", "MEMBER", "OBSERVER"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const create = async (s: Setup, who: Principal, extra: Record<string, unknown> = {}) =>
  (
    await s.d.dispatch(
      who,
      cmd("tasks.create", { title: "Build it", requirements: ["it works"], ...extra }),
    )
  ).response as TaskView;
const update = (s: Setup, who: Principal, task: TaskView, extra: Record<string, unknown>) =>
  s.d.dispatch(
    who,
    cmd("tasks.update", { task_id: task.id, expected_version: task.version, ...extra }),
  );

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

describe("tasks.create", () => {
  it("creates an OPEN, unowned task at version 1 and emits task.created", async () => {
    const s = await setup();
    const out = await s.d.dispatch(
      s.dev,
      cmd("tasks.create", {
        title: "  Build it ",
        description: "All of it",
        requirements: ["compiles", "tested"],
        priority: 1,
      }),
    );
    const task = out.response as TaskView;
    expect(task).toMatchObject({
      room_id: s.room,
      title: "Build it",
      description: "All of it",
      requirements: ["compiles", "tested"],
      status: "OPEN",
      owner_id: null,
      created_by: s.dev.participant_id,
      priority: 1,
      dependencies: [],
      reviewer_id: null,
      review_required: true,
      version: 1,
    });
    expect(task.id).toMatch(/^task_/);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      type: "task.created",
      actor_id: s.dev.participant_id,
      payload: { task: { id: task.id, title: "Build it" } },
    });
  });

  it("takes review_required from the room's settings unless it is given", async () => {
    const s = await setup({ review_required_default: false });
    expect((await create(s, s.dev)).review_required).toBe(false);
    expect((await create(s, s.dev, { review_required: true })).review_required).toBe(true);
    const t = await setup({ review_required_default: "yes" }); // not a boolean: ignored
    expect((await create(t, t.dev)).review_required).toBe(true);
  });

  it("needs at least one requirement and a title", async () => {
    const s = await setup();
    for (const extra of [
      { requirements: [] },
      { requirements: [" "] },
      { title: "  " },
      { title: "x".repeat(201) },
      { priority: 4 },
      { priority: -1 },
      { priority: 1.5 },
      { requirements: Array.from({ length: 51 }, () => "r") },
      { unknown: true },
    ]) {
      await rejects(
        s.d.dispatch(s.dev, cmd("tasks.create", { title: "T", requirements: ["r"], ...extra })),
        "VALIDATION",
      );
    }
    await rejects(s.d.dispatch(s.dev, cmd("tasks.create", { title: "T" })), "VALIDATION");
  });

  it("checks dependencies are tasks of this room", async () => {
    const s = await setup();
    const other = await setup();
    const a = await create(s, s.dev);
    const foreign = await create(other, other.dev);
    const ok = await create(s, s.dev, { dependencies: [a.id, a.id] });
    expect(ok.dependencies).toEqual([a.id]); // duplicates collapse
    const err = await rejects(
      create(s, s.dev, { dependencies: [a.id, "task_nope"] }),
      "VALIDATION",
    );
    expect(err.message).toMatch(/task_nope/);
    await rejects(create(s, s.dev, { dependencies: [foreign.id] }), "VALIDATION");
  });

  it("checks the reviewer is a member of the room", async () => {
    const s = await setup();
    const other = await setup();
    expect((await create(s, s.dev, { reviewer_id: s.reviewer.participant_id })).reviewer_id).toBe(
      s.reviewer.participant_id,
    );
    await rejects(create(s, s.dev, { reviewer_id: other.dev.participant_id }), "VALIDATION");
    await rejects(create(s, s.dev, { reviewer_id: "part_nope" }), "VALIDATION");
  });

  it("is for roles with tasks.create: not reviewers or observers", async () => {
    const s = await setup();
    for (const who of [s.reviewer, s.observer]) {
      await rejects(
        s.d.dispatch(who, cmd("tasks.create", { title: "T", requirements: ["r"] })),
        "FORBIDDEN",
      );
    }
    await create(s, s.lead);
    await create(s, s.owner);
  });

  it("is idempotent per key", async () => {
    const s = await setup();
    const envelope = cmd("tasks.create", { title: "T", requirements: ["r"] });
    const a = await s.d.dispatch(s.dev, envelope);
    const b = await s.d.dispatch(s.dev, envelope);
    expect(b.replayed).toBe(true);
    expect((b.response as TaskView).id).toBe((a.response as TaskView).id);
    const { rows } = await pool.query("SELECT 1 FROM tasks WHERE room_id = $1", [s.room]);
    expect(rows).toHaveLength(1);
  });
});

describe("tasks.update", () => {
  it("changes fields, bumps the version and emits task.updated with what changed", async () => {
    const s = await setup();
    const task = await create(s, s.dev);
    const out = await update(s, s.dev, task, {
      title: "Better",
      priority: 0,
      requirements: ["a", "b"],
    });
    const next = out.response as TaskView;
    expect(next).toMatchObject({
      title: "Better",
      priority: 0,
      requirements: ["a", "b"],
      version: 2,
    });
    expect(new Date(next.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(task.updated_at).getTime(),
    );
    expect(out.events[0]).toMatchObject({
      type: "task.updated",
      payload: {
        task_id: task.id,
        from_version: 1,
        version: 2,
        changes: { title: "Better", priority: 0, requirements: ["a", "b"] },
      },
    });
    expect(Object.keys((out.events[0]!.payload as { changes: object }).changes).sort()).toEqual([
      "priority",
      "requirements",
      "title",
    ]);
  });

  it("answers a stale expected_version with CONFLICT_VERSION carrying the current task", async () => {
    const s = await setup();
    const task = await create(s, s.dev);
    await update(s, s.dev, task, { title: "First" });
    const err = await rejects(update(s, s.dev, task, { title: "Second" }), "CONFLICT_VERSION");
    expect(err.retryable).toBe(true);
    expect(err.details).toMatchObject({ current: { id: task.id, title: "First", version: 2 } });
    // Nothing changed, no event.
    const { rows } = await pool.query("SELECT title FROM tasks WHERE id = $1", [task.id]);
    expect(rows[0].title).toBe("First");
  });

  it("ten concurrent updates from one version: exactly one wins, nine get CONFLICT_VERSION", async () => {
    const s = await setup();
    const task = await create(s, s.dev);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => update(s, s.dev, task, { title: `T${i}` })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected")
        expect((r.reason as CrossoverError).code).toBe("CONFLICT_VERSION");
    }
    const { rows } = await pool.query("SELECT version FROM tasks WHERE id = $1", [task.id]);
    expect(rows[0].version).toBe(2);
  });

  it("rejects unknown dependencies, itself and loops", async () => {
    const s = await setup();
    const a = await create(s, s.dev);
    const b = await create(s, s.dev, { dependencies: [a.id] });
    const c = await create(s, s.dev, { dependencies: [b.id] });
    await rejects(update(s, s.dev, a, { dependencies: ["task_nope"] }), "VALIDATION");
    await rejects(update(s, s.dev, a, { dependencies: [a.id] }), "VALIDATION");
    await rejects(update(s, s.dev, a, { dependencies: [b.id] }), "VALIDATION"); // a→b→a
    const err = await rejects(update(s, s.dev, a, { dependencies: [c.id] }), "VALIDATION"); // a→c→b→a
    expect(err.message).toMatch(/cycle/);
    const ok = await update(s, s.dev, a, { dependencies: [] });
    expect((ok.response as TaskView).dependencies).toEqual([]);
  });

  it("lets the creator edit an open task, but not other developers", async () => {
    const s = await setup();
    const task = await create(s, s.dev);
    await rejects(update(s, s.dev2, task, { title: "Mine now" }), "FORBIDDEN");
    await update(s, s.dev, task, { title: "Still mine" });
  });

  it("lets the owner of a claimed task, the lead, an owner and an admin update it", async () => {
    const s = await setup();
    const task = await create(s, s.dev);
    await pool.query("UPDATE tasks SET status = 'CLAIMED', owner_id = $2 WHERE id = $1", [
      task.id,
      s.dev2.participant_id,
    ]);
    let version = task.version;
    for (const who of [s.dev2, s.lead, s.owner, s.admin]) {
      const out = await update(s, who, { ...task, version }, { priority: 3 });
      version = (out.response as TaskView).version;
    }
    // The creator no longer can, once someone else owns it.
    const { rows } = await pool.query("SELECT version FROM tasks WHERE id = $1", [task.id]);
    await rejects(
      update(s, s.dev, { ...task, version: rows[0].version }, { priority: 1 }),
      "FORBIDDEN",
    );
    await rejects(
      update(s, s.observer, { ...task, version: rows[0].version }, { priority: 1 }),
      "FORBIDDEN",
    );
  });

  it("only the lead, owner or an admin can override dependencies", async () => {
    const s = await setup();
    const task = await create(s, s.dev);
    await rejects(update(s, s.dev, task, { override_dependencies: true }), "FORBIDDEN");
    const out = await update(s, s.lead, task, { override_dependencies: true });
    expect((out.response as TaskView).override_dependencies).toBe(true);
  });

  it("can't update a finished task, or with nothing to change", async () => {
    const s = await setup();
    const task = await create(s, s.dev);
    await rejects(
      s.d.dispatch(s.dev, cmd("tasks.update", { task_id: task.id, expected_version: 1 })),
      "VALIDATION",
    );
    for (const status of ["DONE", "CANCELLED"]) {
      const t = await create(s, s.dev);
      await pool.query("UPDATE tasks SET status = $2, owner_id = $3 WHERE id = $1", [
        t.id,
        status,
        s.dev.participant_id,
      ]);
      await rejects(update(s, s.owner, t, { title: "x" }), "VALIDATION");
    }
  });

  it("answers NOT_FOUND for an unknown task or one in another room", async () => {
    const s = await setup();
    const other = await setup();
    const foreign = await create(other, other.dev);
    await rejects(update(s, s.owner, foreign, { title: "x" }), "NOT_FOUND");
    await rejects(
      s.d.dispatch(
        s.owner,
        cmd("tasks.update", { task_id: "task_nope", expected_version: 1, title: "x" }),
      ),
      "NOT_FOUND",
    );
  });

  it("can clear the reviewer, and checks a new one", async () => {
    const s = await setup();
    const task = await create(s, s.dev, { reviewer_id: s.reviewer.participant_id });
    const cleared = await update(s, s.dev, task, { reviewer_id: null });
    expect((cleared.response as TaskView).reviewer_id).toBeNull();
    await rejects(
      update(s, s.dev, cleared.response as TaskView, { reviewer_id: "part_nope" }),
      "VALIDATION",
    );
  });
});
