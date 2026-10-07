import { createHmac } from "node:crypto";
import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { newId, type CrossoverError } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { deliverInbox } from "./inbox.js";
import {
  registerWakeSecretCommand,
  signWake,
  WakeWebhookService,
  wakeSecretFor,
  type WakeRequest,
} from "./wake.js";

let db: TestDatabase;
let pool: Pool;
let n = 0;
const KEY = "k".repeat(40);

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});
afterAll(async () => {
  await db.drop();
});

async function setup() {
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  const add = async (kind: "HUMAN" | "AGENT", manifest: object | null, status = "ACTIVE") => {
    const id = newId("part");
    await pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status, agent_manifest)
       VALUES ($1, $2, $3, $1, 'MEMBER', 'DEVELOPER', $4, $5::jsonb)`,
      [id, room, kind, status, manifest ? JSON.stringify(manifest) : null],
    );
    return id;
  };
  const hooked = await add("AGENT", { wake_webhook_url: "https://hooks.example/agent-a" });
  const sent: WakeRequest[] = [];
  let now = 1_700_000_000_000;
  let failing: Error | undefined;
  const service = new WakeWebhookService({
    pool,
    key: KEY,
    lagMs: 0,
    now: () => now,
    sender: async (request) => {
      if (failing) throw failing;
      sent.push(request);
    },
    onError: () => {},
  });
  await service.tick(); // starts from now: nothing before counts
  const give = async (to: string, kind = "MENTION", summary = "secret words from someone") => {
    const client = await pool.connect();
    try {
      return await deliverInbox(client, room, to, {
        kind: kind as "MENTION",
        ref: { kind: "message", id: `msg_${++n}` },
        summary,
        author_id: "system",
      });
    } finally {
      client.release();
    }
  };
  return {
    room,
    add,
    hooked,
    sent,
    service,
    give,
    advance: (ms: number) => (now += ms),
    fail: (error: Error | undefined) => (failing = error),
  };
}

const bodyOf = (r: WakeRequest) =>
  JSON.parse(r.body) as { items: { id: string; kind: string }[]; count: number; dropped: number };

describe("wake-up webhooks (§17.4, T706)", () => {
  it("the first item goes out at once, signed with a scheme the agent can verify, naming ids and kinds only", async () => {
    const s = await setup();
    const id = await s.give(s.hooked, "ASSIGNMENT", "private text that quotes someone");
    expect(await s.service.tick()).toBe(1);
    const [req] = s.sent;
    expect(req!.url).toBe("https://hooks.example/agent-a");
    expect(bodyOf(req!)).toMatchObject({
      count: 1,
      dropped: 0,
      items: [{ id, kind: "ASSIGNMENT" }],
    });
    expect(req!.body).not.toContain("private text");
    // Verifiable with the documented algorithm and the secret the agent can read.
    const timestamp = req!.headers["x-crossover-timestamp"]!;
    const expected = `sha256=${createHmac("sha256", wakeSecretFor(KEY, s.hooked)).update(`${timestamp}.${req!.body}`).digest("hex")}`;
    expect(req!.headers["x-crossover-signature"]).toBe(expected);
    expect(signWake(wakeSecretFor(KEY, s.hooked), timestamp, req!.body)).toBe(expected);
    expect(req!.headers["x-crossover-signature"]).not.toBe(
      signWake(wakeSecretFor(KEY, "someone_else"), timestamp, req!.body),
    );
    expect(req!.headers["x-crossover-delivery"]).toBeTruthy();
  });

  it("at most one per agent per 30 s: a burst is batched, and goes out when the window passes (fake clock)", async () => {
    const s = await setup();
    await s.give(s.hooked);
    expect(await s.service.tick()).toBe(1);
    const batch: string[] = [];
    for (let i = 0; i < 5; i++) batch.push(await s.give(s.hooked));
    s.advance(10_000);
    expect(await s.service.tick()).toBe(0);
    batch.push(await s.give(s.hooked));
    s.advance(19_000); // 29 s since the first
    expect(await s.service.tick()).toBe(0);
    s.advance(1_000); // 30 s
    expect(await s.service.tick()).toBe(1);
    expect(bodyOf(s.sent[1]!).items.map((i) => i.id)).toEqual(batch);
    expect(bodyOf(s.sent[1]!).count).toBe(6);
    // Nothing new: nothing sent, however long it is.
    s.advance(120_000);
    expect(await s.service.tick()).toBe(0);
    expect(s.sent).toHaveLength(2);
  });

  it("only agents with a webhook, still active: humans, agents without a URL and paused agents are not called", async () => {
    const s = await setup();
    const human = await s.add("HUMAN", null);
    const plain = await s.add("AGENT", { name: "no url" });
    const paused = await s.add("AGENT", { wake_webhook_url: "https://hooks.example/p" }, "PAUSED");
    for (const who of [human, plain, paused]) await s.give(who);
    expect(await s.service.tick()).toBe(0);
    expect(s.sent).toEqual([]);
    // An agent paused after the item arrived isn't called either.
    await s.give(s.hooked);
    await pool.query("UPDATE participants SET status = 'PAUSED' WHERE id = $1", [s.hooked]);
    expect(await s.service.tick()).toBe(0);
  });

  it("items acknowledged before the send are left out", async () => {
    const s = await setup();
    const a = await s.give(s.hooked);
    const b = await s.give(s.hooked);
    await pool.query("UPDATE inbox_items SET acked_at = now() WHERE id = $1", [a]);
    await s.service.tick();
    expect(bodyOf(s.sent[0]!).items.map((i) => i.id)).toEqual([b]);
  });

  it("a delivery that fails is kept and tried again in the next window, once", async () => {
    const s = await setup();
    const id = await s.give(s.hooked);
    s.fail(new Error("receiver is down"));
    expect(await s.service.tick()).toBe(0);
    s.fail(undefined);
    s.advance(5_000);
    expect(await s.service.tick()).toBe(0); // still inside the window the failed try opened
    s.advance(25_000);
    expect(await s.service.tick()).toBe(1);
    expect(bodyOf(s.sent[0]!).items.map((i) => i.id)).toEqual([id]);
    s.advance(60_000);
    expect(await s.service.tick()).toBe(0);
  });

  it("a very long backlog is capped, and says how much was left out", async () => {
    const s = await setup();
    await s.give(s.hooked);
    await s.service.tick();
    for (let i = 0; i < 205; i++) await s.give(s.hooked);
    s.advance(30_000);
    await s.service.tick();
    const body = bodyOf(s.sent[1]!);
    expect(body.items).toHaveLength(200);
    expect(body).toMatchObject({ dropped: 5, count: 205 });
  });
});

describe("participants.wake_secret", () => {
  async function room() {
    const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
    registerWakeSecretCommand(d, KEY);
    const off = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
    registerWakeSecretCommand(off, undefined);
    const id = newId("room");
    await pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [id],
    );
    const add = async (kind: "HUMAN" | "AGENT") => {
      const pid = newId("part");
      await pool.query(
        `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
         VALUES ($1, $2, $3, $1, 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
        [pid, id, kind],
      );
      return {
        participant_id: pid,
        room_id: id,
        kind,
        authority: "MEMBER",
        role: "DEVELOPER",
      } as Principal;
    };
    return {
      d,
      off,
      agent: await add("AGENT"),
      other: await add("AGENT"),
      human: await add("HUMAN"),
    };
  }
  const call = (d: Dispatcher, who: Principal) =>
    d.dispatch(who, { id: newId("cmd"), method: "participants.wake_secret", params: {} });

  it("an agent reads its own secret, the one its wake-ups are signed with; each agent's is different", async () => {
    const r = await room();
    const mine = (await call(r.d, r.agent)).response as { secret: string; algorithm: string };
    expect(mine.secret).toBe(wakeSecretFor(KEY, r.agent.participant_id));
    expect(mine.algorithm).toContain("HMAC-SHA256");
    expect(((await call(r.d, r.other)).response as { secret: string }).secret).not.toBe(
      mine.secret,
    );
  });

  it("a human has no wake-ups, and without a platform key there are none to sign", async () => {
    const r = await room();
    const human = await call(r.d, r.human).catch((e: unknown) => e);
    expect((human as CrossoverError).details).toMatchObject({ reason: "not_an_agent" });
    const off = await call(r.off, r.agent).catch((e: unknown) => e);
    expect((off as CrossoverError).details).toMatchObject({ reason: "not_configured" });
  });
});
