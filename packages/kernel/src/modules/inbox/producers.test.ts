import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerMessageCommands } from "../messages/messages.js";
import { registerTaskCommands } from "../tasks/create-update.js";
import { sweepExpiredLeases } from "../tasks/leases.js";
import { registerTaskLifecycleCommands } from "../tasks/lifecycle.js";
import type { TaskView } from "../tasks/task.js";
import { registerInboxCommands } from "./inbox.js";

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

async function add(room: string, role: string, kind: "HUMAN" | "AGENT" = "AGENT") {
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
  registerTaskLifecycleCommands(d);
  registerMessageCommands(d);
  registerInboxCommands(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  return {
    d,
    room,
    lead: await add(room, "LEAD"),
    dev: await add(room, "DEVELOPER"),
    dev2: await add(room, "DEVELOPER"),
    reviewer: await add(room, "REVIEWER"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** Everything in the room's inboxes: who got what, in order. */
async function inboxes(s: Setup) {
  const { rows } = await pool.query<{
    participant_id: string;
    kind: string;
    ref: { kind: string; id: string };
    summary: string;
  }>(
    "SELECT participant_id, kind, ref, summary FROM inbox_items WHERE room_id = $1 ORDER BY created_at, id",
    [s.room],
  );
  return rows;
}
const to = (rows: Awaited<ReturnType<typeof inboxes>>, p: Principal) =>
  rows.filter((r) => r.participant_id === p.participant_id);

const create = async (s: Setup, extra: Record<string, unknown> = {}) =>
  (
    await s.d.dispatch(
      s.lead,
      cmd("tasks.create", { title: "Build it", requirements: ["r"], ...extra }),
    )
  ).response as TaskView;

/** An in-progress task owned by `owner`. */
async function inProgress(s: Setup, owner: Principal, extra: Record<string, unknown> = {}) {
  const t = await create(s, extra);
  const claimed = (
    await s.d.dispatch(owner, cmd("tasks.claim", { task_id: t.id, expected_version: t.version }))
  ).response as TaskView;
  return (
    await s.d.dispatch(
      owner,
      cmd("tasks.start", { task_id: t.id, expected_version: claimed.version }),
    )
  ).response as TaskView;
}
const submit = (s: Setup, who: Principal, t: TaskView) =>
  s.d.dispatch(who, cmd("tasks.submit", { task_id: t.id, expected_version: t.version }));

describe("mentions", () => {
  it("go to exactly the mentioned participants, with the message as the reference", async () => {
    const s = await setup();
    const sent = (
      await s.d.dispatch(
        s.dev,
        cmd("messages.send", {
          body: "ping",
          mentions: [s.lead.participant_id, s.dev2.participant_id],
        }),
      )
    ).response as { id: string };
    const rows = await inboxes(s);
    expect(rows.map((r) => r.participant_id).sort()).toEqual(
      [s.lead.participant_id, s.dev2.participant_id].sort(),
    );
    expect(rows.every((r) => r.kind === "MENTION")).toBe(true);
    expect(rows.every((r) => r.ref.kind === "message" && r.ref.id === sent.id)).toBe(true);
    expect(rows[0]!.summary).toBe("ping");
  });

  it("not to the author, not to anyone unmentioned, and once per participant", async () => {
    const s = await setup();
    await s.d.dispatch(
      s.dev,
      cmd("messages.send", {
        body: "me and you",
        mentions: [s.dev.participant_id, s.lead.participant_id, s.lead.participant_id],
      }),
    );
    const rows = await inboxes(s);
    expect(rows.map((r) => r.participant_id)).toEqual([s.lead.participant_id]);
    await s.d.dispatch(s.dev, cmd("messages.send", { body: "no mentions" }));
    expect(await inboxes(s)).toHaveLength(1);
  });

  it("a message that is refused delivers nothing", async () => {
    const s = await setup();
    await expect(
      s.d.dispatch(
        s.dev,
        cmd("messages.send", { body: "x", mentions: [s.lead.participant_id, "part_nobody"] }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await inboxes(s)).toEqual([]);
  });
});

describe("assignment", () => {
  it("goes to the assignee only", async () => {
    const s = await setup();
    const t = await create(s);
    await s.d.dispatch(
      s.lead,
      cmd("tasks.assign", {
        task_id: t.id,
        expected_version: t.version,
        participant_id: s.dev.participant_id,
      }),
    );
    const rows = await inboxes(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      participant_id: s.dev.participant_id,
      kind: "ASSIGNMENT",
      ref: { kind: "task", id: t.id },
    });
    expect(rows[0]!.summary).toContain("Build it");
  });

  it("assigning to yourself is not news, and a plain claim notifies nobody", async () => {
    const s = await setup();
    const t = await create(s);
    await s.d.dispatch(
      s.lead,
      cmd("tasks.assign", {
        task_id: t.id,
        expected_version: t.version,
        participant_id: s.lead.participant_id,
      }),
    );
    const u = await create(s);
    await s.d.dispatch(s.dev, cmd("tasks.claim", { task_id: u.id, expected_version: u.version }));
    expect(await inboxes(s)).toEqual([]);
  });
});

describe("review requested", () => {
  it("goes to the named reviewer, and only to them", async () => {
    const s = await setup();
    const t = await inProgress(s, s.dev, { reviewer_id: s.reviewer.participant_id });
    await submit(s, s.dev, t);
    const rows = await inboxes(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      participant_id: s.reviewer.participant_id,
      kind: "REVIEW_REQUEST",
      ref: { kind: "task", id: t.id },
    });
  });

  it("goes to the lead when no reviewer is named", async () => {
    const s = await setup();
    const t = await inProgress(s, s.dev);
    await submit(s, s.dev, t);
    expect((await inboxes(s)).map((r) => [r.participant_id, r.kind])).toEqual([
      [s.lead.participant_id, "REVIEW_REQUEST"],
    ]);
  });

  it("falls back to the lead when the named reviewer has been removed", async () => {
    const s = await setup();
    const t = await inProgress(s, s.dev, { reviewer_id: s.reviewer.participant_id });
    await pool.query("UPDATE participants SET status = 'REMOVED' WHERE id = $1", [
      s.reviewer.participant_id,
    ]);
    await submit(s, s.dev, t);
    expect((await inboxes(s)).map((r) => r.participant_id)).toEqual([s.lead.participant_id]);
  });

  it("a lead who submits their own task is not asked to review it", async () => {
    const s = await setup();
    const t = await inProgress(s, s.lead);
    await submit(s, s.lead, t);
    expect(await inboxes(s)).toEqual([]);
  });

  it("a task that needs no review notifies nobody", async () => {
    const s = await setup();
    const t = await inProgress(s, s.dev, { review_required: false });
    const out = await submit(s, s.dev, t);
    expect((out.response as TaskView).status).toBe("DONE");
    expect(await inboxes(s)).toEqual([]);
  });

  it("a refused submit notifies nobody", async () => {
    const s = await setup();
    const t = await inProgress(s, s.dev);
    await expect(submit(s, s.dev2, t)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await inboxes(s)).toEqual([]);
  });
});

describe("lease expired", () => {
  const expire = (taskId: string) =>
    pool.query("UPDATE tasks SET lease_expires_at = now() - interval '1 minute' WHERE id = $1", [
      taskId,
    ]);

  it("goes to the lead, one item per released task", async () => {
    const s = await setup();
    const a = await inProgress(s, s.dev);
    const b = await inProgress(s, s.dev2);
    await expire(a.id);
    await expire(b.id);
    const swept = await sweepExpiredLeases(s.d, pool, { rooms: [s.room] });
    expect(swept).toHaveLength(2);
    const rows = await inboxes(s);
    expect(rows.map((r) => r.participant_id)).toEqual([
      s.lead.participant_id,
      s.lead.participant_id,
    ]);
    expect(rows.every((r) => r.kind === "LEASE_EXPIRED")).toBe(true);
    expect(rows.map((r) => r.ref.id).sort()).toEqual([a.id, b.id].sort());
    expect(to(rows, s.dev)).toEqual([]);
  });

  it("nothing for a task whose lease hasn't lapsed, nor when the room has no lead", async () => {
    const s = await setup();
    await inProgress(s, s.dev);
    await sweepExpiredLeases(s.d, pool, { rooms: [s.room] });
    expect(await inboxes(s)).toEqual([]);

    const t = await inProgress(s, s.dev2);
    await expire(t.id);
    await pool.query("UPDATE participants SET role = 'DEVELOPER' WHERE id = $1", [
      s.lead.participant_id,
    ]);
    const swept = await sweepExpiredLeases(s.d, pool, { rooms: [s.room] });
    expect(swept).toHaveLength(1); // still released
    expect(await inboxes(s)).toEqual([]);
  });
});
