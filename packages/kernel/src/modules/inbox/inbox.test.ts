import { withTransaction, type Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { deliverInbox, MAX_ACK, registerInboxCommands, type InboxItem } from "./inbox.js";

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

async function add(room: string, role: string): Promise<Principal> {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'AGENT', $1, 'MEMBER', $3, 'ACTIVE')`,
    [id, room, role],
  );
  return {
    participant_id: id,
    room_id: room,
    kind: "AGENT",
    authority: "MEMBER",
    role,
  } as Principal;
}

async function setup() {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerInboxCommands(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  return {
    d,
    room,
    a: await add(room, "DEVELOPER"),
    b: await add(room, "DEVELOPER"),
    observer: await add(room, "OBSERVER"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const deliver = (
  s: Setup,
  to: Principal,
  summary = "Something happened",
  kind: "MENTION" | "ASSIGNMENT" = "MENTION",
) =>
  withTransaction(pool, (c) =>
    deliverInbox(c, s.room, to.participant_id, {
      kind,
      ref: { kind: "task", id: "task_1" },
      summary,
    }),
  );
const list = async (s: Setup, who: Principal, params: Record<string, unknown> = {}) =>
  (await s.d.dispatch(who, read("inbox.list", params))).response as {
    items: InboxItem[];
    has_more: boolean;
  };
const ack = (s: Setup, who: Principal, ids: string[]) =>
  s.d.dispatch(who, cmd("inbox.ack", { ids }));

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

describe("deliverInbox", () => {
  it("puts an unacknowledged item in the participant's inbox", async () => {
    const s = await setup();
    const id = await deliver(s, s.a, "Task assigned", "ASSIGNMENT");
    const [item] = (await list(s, s.a)).items;
    expect(item).toMatchObject({
      id,
      kind: "ASSIGNMENT",
      ref: { kind: "task", id: "task_1" },
      summary: "Task assigned",
      acked_at: null,
    });
    expect(id).toMatch(/^inbox_/);
  });

  it("is part of the caller's transaction: it disappears if that rolls back", async () => {
    const s = await setup();
    await withTransaction(pool, async (c) => {
      await deliverInbox(c, s.room, s.a.participant_id, {
        kind: "MENTION",
        ref: { kind: "message", id: "m" },
        summary: "x",
      });
      throw new Error("rollback");
    }).catch(() => undefined);
    expect((await list(s, s.a)).items).toEqual([]);
  });

  it("truncates a long summary and refuses a recipient outside the room", async () => {
    const s = await setup();
    const other = await setup();
    await deliver(s, s.a, "x".repeat(900));
    expect((await list(s, s.a)).items[0]!.summary).toHaveLength(500);
    await expect(deliver(s, other.a)).rejects.toMatchObject({ code: "23503" });
  });
});

describe("inbox.list", () => {
  it("shows only the caller's own items, oldest first", async () => {
    const s = await setup();
    const first = await deliver(s, s.a, "one");
    await deliver(s, s.b, "someone else's");
    const third = await deliver(s, s.a, "two");
    expect((await list(s, s.a)).items.map((i) => i.id)).toEqual([first, third]);
    expect((await list(s, s.b)).items).toHaveLength(1);
    expect((await list(s, s.observer)).items).toEqual([]);
  });

  it("hides acknowledged items unless asked for them", async () => {
    const s = await setup();
    const a = await deliver(s, s.a, "one");
    const b = await deliver(s, s.a, "two");
    await ack(s, s.a, [a]);
    expect((await list(s, s.a)).items.map((i) => i.id)).toEqual([b]);
    expect((await list(s, s.a, { unacked_only: true })).items.map((i) => i.id)).toEqual([b]);
    const all = (await list(s, s.a, { unacked_only: false })).items;
    expect(all.map((i) => i.id)).toEqual([a, b]);
    expect(all[0]!.acked_at).not.toBeNull();
  });

  it("pages with after and limit, every item exactly once", async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push(await deliver(s, s.a, `item ${i}`));
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await list(s, s.a, { limit: 4, ...(after ? { after } : {}) });
      seen.push(...page.items.map((i) => i.id));
      if (!page.has_more) break;
      after = page.items.at(-1)!.id;
    }
    expect(seen).toEqual(ids);
  });

  it("rejects a bad cursor or limit, and someone else's item as a cursor", async () => {
    const s = await setup();
    const theirs = await deliver(s, s.b);
    await rejects(s.d.dispatch(s.a, read("inbox.list", { after: "inbox_nope" })), "NOT_FOUND");
    await rejects(s.d.dispatch(s.a, read("inbox.list", { after: theirs })), "NOT_FOUND");
    for (const limit of [0, 101])
      await rejects(s.d.dispatch(s.a, read("inbox.list", { limit })), "VALIDATION");
  });

  it("is available to observers, who can read their own inbox", async () => {
    const s = await setup();
    await deliver(s, s.observer);
    expect((await list(s, s.observer)).items).toHaveLength(1);
  });
});

describe("inbox.ack", () => {
  it("acknowledges items and reports how many were new", async () => {
    const s = await setup();
    const [x, y] = [await deliver(s, s.a), await deliver(s, s.a)];
    const out = await ack(s, s.a, [x, y]);
    expect(out.response).toEqual({ acked: 2, ids: [x, y] });
    expect((await list(s, s.a)).items).toEqual([]);
  });

  it("is idempotent: acking again is fine and keeps the first timestamp", async () => {
    const s = await setup();
    const id = await deliver(s, s.a);
    await ack(s, s.a, [id]);
    const first = (await pool.query("SELECT acked_at FROM inbox_items WHERE id = $1", [id])).rows[0]
      .acked_at;
    const again = await ack(s, s.a, [id, id]);
    expect(again.response).toMatchObject({ acked: 0 });
    const second = (await pool.query("SELECT acked_at FROM inbox_items WHERE id = $1", [id]))
      .rows[0].acked_at;
    expect(second).toEqual(first);
    // And a mix of new and old counts only the new.
    const fresh = await deliver(s, s.a);
    expect((await ack(s, s.a, [id, fresh])).response).toMatchObject({ acked: 1 });
  });

  it("acking another participant's item → NOT_FOUND, and nothing in the request is acked", async () => {
    const s = await setup();
    const mine = await deliver(s, s.a);
    const theirs = await deliver(s, s.b);
    const err = await rejects(ack(s, s.a, [mine, theirs]), "NOT_FOUND");
    expect(err.details).toMatchObject({ ids: [theirs] });
    const { rows } = await pool.query("SELECT id, acked_at FROM inbox_items WHERE id = ANY($1)", [
      [mine, theirs],
    ]);
    expect(rows.every((r) => r.acked_at === null)).toBe(true);
  });

  it("looks the same for an unknown id and for someone else's", async () => {
    const s = await setup();
    const theirs = await deliver(s, s.b);
    const a = await rejects(ack(s, s.a, [theirs]), "NOT_FOUND");
    const b = await rejects(ack(s, s.a, ["inbox_nope"]), "NOT_FOUND");
    expect(a.message.replace(theirs, "X")).toBe(b.message.replace("inbox_nope", "X"));
  });

  it("an item of another room can't be acked either", async () => {
    const s = await setup();
    const other = await setup();
    const foreign = await deliver(other, other.a);
    await rejects(ack(s, s.a, [foreign]), "NOT_FOUND");
  });

  it("observers may ack their own items", async () => {
    const s = await setup();
    const id = await deliver(s, s.observer);
    expect((await ack(s, s.observer, [id])).response).toMatchObject({ acked: 1 });
  });

  it("needs 1 to 100 ids", async () => {
    const s = await setup();
    await rejects(ack(s, s.a, []), "VALIDATION");
    await rejects(
      ack(
        s,
        s.a,
        Array.from({ length: MAX_ACK + 1 }, (_, i) => `inbox_${i}`),
      ),
      "VALIDATION",
    );
    await rejects(s.d.dispatch(s.a, cmd("inbox.ack", { ids: ["x"], extra: 1 })), "VALIDATION");
  });

  it("concurrent acks of the same items both succeed and ack once", async () => {
    const s = await setup();
    const id = await deliver(s, s.a);
    const results = await Promise.all(Array.from({ length: 6 }, () => ack(s, s.a, [id])));
    expect(results.reduce((sum, r) => sum + (r.response as { acked: number }).acked, 0)).toBe(1);
  });
});
