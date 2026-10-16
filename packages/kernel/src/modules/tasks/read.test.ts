import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerTaskCommands } from "./create-update.js";
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
const read = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
});

async function add(
  room: string,
  role: string,
  kind: "HUMAN" | "AGENT" = "AGENT",
): Promise<Principal> {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, $3, $1, 'MEMBER', $4, 'ACTIVE')`,
    [id, room, kind, role],
  );
  return { participant_id: id, room_id: room, kind, authority: "MEMBER", role } as Principal;
}

async function setup() {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerTaskCommands(d);
  registerTaskReadCommands(d);
  const room = newId("room");
  const ownerId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', $2)`,
    [room, ownerId],
  );
  return {
    d,
    room,
    dev: await add(room, "DEVELOPER"),
    dev2: await add(room, "DEVELOPER"),
    observer: await add(room, "OBSERVER"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const mk = async (s: Setup, title: string, extra: Record<string, unknown> = {}) =>
  (await s.d.dispatch(s.dev, cmd("tasks.create", { title, requirements: ["r"], ...extra })))
    .response as TaskView;
const list = async (s: Setup, who: Principal, params: Record<string, unknown> = {}) =>
  (await s.d.dispatch(who, read("tasks.list", params))).response as {
    tasks: TaskView[];
    next_cursor: string | null;
  };
const setStatus = (id: string, status: string, owner: Principal | null) =>
  pool.query("UPDATE tasks SET status = $2, owner_id = $3 WHERE id = $1", [
    id,
    status,
    owner?.participant_id ?? null,
  ]);

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
};

describe("tasks.list", () => {
  it("lists a room's tasks oldest first, for anyone who can read", async () => {
    const s = await setup();
    const a = await mk(s, "A");
    const b = await mk(s, "B");
    const out = await list(s, s.observer);
    expect(out.tasks.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(out.next_cursor).toBeNull();
  });

  it("only lists the caller's room", async () => {
    const s = await setup();
    const other = await setup();
    await mk(other, "elsewhere");
    const mine = await mk(s, "mine");
    expect((await list(s, s.dev)).tasks.map((t) => t.id)).toEqual([mine.id]);
  });

  it("filters by status (any of several)", async () => {
    const s = await setup();
    const open = await mk(s, "open");
    const claimed = await mk(s, "claimed");
    const done = await mk(s, "done");
    await setStatus(claimed.id, "CLAIMED", s.dev);
    await setStatus(done.id, "DONE", s.dev);
    expect((await list(s, s.dev, { status: ["OPEN"] })).tasks.map((t) => t.id)).toEqual([open.id]);
    expect((await list(s, s.dev, { status: ["CLAIMED", "DONE"] })).tasks.map((t) => t.id)).toEqual([
      claimed.id,
      done.id,
    ]);
    await rejects(s.d.dispatch(s.dev, read("tasks.list", { status: ["NOPE"] })), "VALIDATION");
    await rejects(s.d.dispatch(s.dev, read("tasks.list", { status: [] })), "VALIDATION");
  });

  it("filters by owner and by mine", async () => {
    const s = await setup();
    const a = await mk(s, "a");
    const b = await mk(s, "b");
    await mk(s, "unowned");
    await setStatus(a.id, "CLAIMED", s.dev);
    await setStatus(b.id, "CLAIMED", s.dev2);
    expect((await list(s, s.dev, { mine: true })).tasks.map((t) => t.id)).toEqual([a.id]);
    expect(
      (await list(s, s.dev, { owner_id: s.dev2.participant_id })).tasks.map((t) => t.id),
    ).toEqual([b.id]);
    expect(
      (await list(s, s.dev, { mine: true, owner_id: s.dev.participant_id })).tasks,
    ).toHaveLength(1);
    await rejects(
      s.d.dispatch(s.dev, read("tasks.list", { mine: true, owner_id: s.dev2.participant_id })),
      "VALIDATION",
    );
    expect((await list(s, s.dev, { mine: true, status: ["CLAIMED"] })).tasks).toHaveLength(1);
    expect((await list(s, s.dev, { mine: true, status: ["OPEN"] })).tasks).toHaveLength(0);
  });

  // Measured (T1529): idle n/a, 3x load 2723 ms; budget 7x.
  it("pages through every task exactly once, including ones that share a timestamp", async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) ids.push((await mk(s, `T${i}`)).id);
    // Make groups of tasks share one created_at to exercise the (created_at, id) tie-break.
    await pool.query(
      `UPDATE tasks SET created_at = '2030-01-01T00:00:00.123456Z'::timestamptz + (substr(title, 2)::int / 5) * interval '1 second'
       WHERE room_id = $1`,
      [s.room],
    );
    for (const limit of [1, 4, 5, 10, 23, 100]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await list(s, s.dev, { limit, ...(cursor ? { cursor } : {}) });
        seen.push(...page.tasks.map((t) => t.id));
        cursor = page.next_cursor ?? undefined;
        pages++;
      } while (cursor && pages < 100);
      expect(seen, `limit ${limit}`).toHaveLength(23);
      expect(new Set(seen).size).toBe(23);
      expect(new Set(seen)).toEqual(new Set(ids));
    }
  }, 20_000);

  it("keeps microsecond precision in the cursor (no skipped or repeated rows)", async () => {
    const s = await setup();
    for (let i = 0; i < 6; i++) await mk(s, `T${i}`);
    await pool.query(
      `UPDATE tasks SET created_at = '2031-05-05T10:00:00Z'::timestamptz + (substr(title, 2)::int) * interval '1 microsecond' WHERE room_id = $1`,
      [s.room],
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(s, s.dev, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.tasks.map((t) => t.title));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["T0", "T1", "T2", "T3", "T4", "T5"]);
  });

  it("breaks ties by id even when rows were inserted in the opposite order", async () => {
    const s = await setup();
    for (const id of ["task_f", "task_e", "task_d", "task_c", "task_b", "task_a"]) {
      await pool.query(
        `INSERT INTO tasks (id, room_id, title, created_by, created_at)
         VALUES ($1, $2, $1, $3, '2032-02-02T00:00:00Z')`,
        [id, s.room, s.dev.participant_id],
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(s, s.dev, { limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.tasks.map((t) => t.id));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(["task_a", "task_b", "task_c", "task_d", "task_e", "task_f"]);
  });

  it("a task created while paging shows up after the cursor, never twice", async () => {
    const s = await setup();
    await mk(s, "a");
    await mk(s, "b");
    const first = await list(s, s.dev, { limit: 1 });
    const late = await mk(s, "late");
    const rest = await list(s, s.dev, { limit: 10, cursor: first.next_cursor! });
    const all = [...first.tasks, ...rest.tasks].map((t) => t.title);
    expect(all).toEqual(["a", "b", "late"]);
    expect(rest.tasks.at(-1)!.id).toBe(late.id);
  });

  it("refuses a bad cursor or limit", async () => {
    const s = await setup();
    await rejects(s.d.dispatch(s.dev, read("tasks.list", { cursor: "garbage" })), "VALIDATION");
    await rejects(
      s.d.dispatch(s.dev, read("tasks.list", { cursor: Buffer.from("x|y").toString("base64url") })),
      "VALIDATION",
    );
    for (const limit of [0, 101, 1.5]) {
      await rejects(s.d.dispatch(s.dev, read("tasks.list", { limit })), "VALIDATION");
    }
  });

  it("a cursor only ever pages the caller's own room", async () => {
    const s = await setup();
    const other = await setup();
    await mk(other, "secret");
    const mine = await mk(s, "mine");
    const cursor = Buffer.from("1999-01-01T00:00:00.000000Z|task_a").toString("base64url");
    expect((await list(s, s.dev, { cursor })).tasks.map((t) => t.id)).toEqual([mine.id]);
  });
});

describe("tasks.get", () => {
  it("returns the task with its reviews", async () => {
    const s = await setup();
    const task = await mk(s, "reviewed");
    await pool.query(
      `INSERT INTO task_reviews (id, room_id, task_id, reviewer_id, verdict, comments, revision)
       VALUES ($1, $2, $3, $4, 'REQUEST_CHANGES', 'tidy up', 7)`,
      [newId("rev"), s.room, task.id, s.dev2.participant_id],
    );
    const out = (await s.d.dispatch(s.observer, read("tasks.get", { task_id: task.id })))
      .response as TaskView & { reviews: unknown[] };
    expect(out).toMatchObject({ id: task.id, title: "reviewed", version: 1 });
    expect(out.reviews).toEqual([
      expect.objectContaining({
        reviewer_id: s.dev2.participant_id,
        verdict: "REQUEST_CHANGES",
        comments: "tidy up",
        revision: 7,
      }),
    ]);
  });

  it("is NOT_FOUND for an unknown task or one in another room", async () => {
    const s = await setup();
    const other = await setup();
    const foreign = await mk(other, "x");
    await rejects(s.d.dispatch(s.dev, read("tasks.get", { task_id: foreign.id })), "NOT_FOUND");
    await rejects(s.d.dispatch(s.dev, read("tasks.get", { task_id: "task_nope" })), "NOT_FOUND");
  });
});
