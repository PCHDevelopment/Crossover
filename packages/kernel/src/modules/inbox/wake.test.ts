import { createHmac } from "node:crypto";
import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { newId, type CrossoverError } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Dispatcher, type EmittedEvent } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { deliverInbox } from "./inbox.js";
import {
  registerWakeSecretCommand,
  signWake,
  WakeWebhookService,
  wakeSecretFor,
  type WakeRequest,
  type WakeSender,
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
  // The database is shared by the tests: what earlier ones left waiting is not this one's business.
  await pool.query(
    "UPDATE inbox_items SET wake_notified_at = now() WHERE wake_notified_at IS NULL",
  );
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
  let sender: WakeSender = async (request) => {
    if (failing) throw failing;
    sent.push(request);
  };
  /** A node: its own service object, the same database. */
  const node = (
    options: {
      batch?: number;
      sender?: WakeSender;
      concurrency?: number;
      agentsPerTick?: number;
      /** A pool standing in for the database (to make one query fail). */
      pool?: Pool;
      /** No fake clock: the database's own. */
      realClock?: boolean;
      key?: string | undefined;
    } = {},
  ) =>
    new WakeWebhookService({
      pool: options.pool ?? pool,
      key: "key" in options ? options.key : KEY,
      ...(options.realClock ? {} : { now: () => now }),
      sender: options.sender ?? ((request) => sender(request)),
      onError: () => {},
      ...(options.batch ? { batch: options.batch } : {}),
      ...(options.concurrency ? { concurrency: options.concurrency } : {}),
      ...(options.agentsPerTick ? { agentsPerTick: options.agentsPerTick } : {}),
    });
  const give = async (
    to: string,
    kind = "MENTION",
    summary = "secret words from someone",
    client?: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  ) => {
    const own = client ? undefined : await pool.connect();
    const events: EmittedEvent[] = [];
    try {
      return await deliverInbox(
        (client ?? own) as never,
        room,
        to,
        {
          kind: kind as "MENTION",
          ref: { kind: "message", id: `msg_${++n}` },
          summary,
          author_id: "system",
        },
        events,
      );
    } finally {
      own?.release();
    }
  };
  return {
    room,
    add,
    hooked,
    sent,
    node,
    give,
    advance: (ms: number) => (now += ms),
    fail: (error: Error | undefined) => (failing = error),
    setSender: (next: WakeSender) => (sender = next),
  };
}

const bodyOf = (r: WakeRequest) =>
  JSON.parse(r.body) as {
    items: { id: string; kind: string; ref: Record<string, string> }[];
    count: number;
    more: boolean;
  };

describe("wake-up webhooks (§17.4, T706)", () => {
  it("the first item goes out at once, signed with a scheme the agent can verify, naming ids, kinds and refs only", async () => {
    const s = await setup();
    const id = await s.give(s.hooked, "ASSIGNMENT", "private text that quotes someone");
    expect(await s.node().tick()).toBe(1);
    const [req] = s.sent;
    expect(req!.url).toBe("https://hooks.example/agent-a");
    expect(bodyOf(req!)).toMatchObject({
      count: 1,
      more: false,
      items: [{ id, kind: "ASSIGNMENT" }],
    });
    expect(Object.keys(bodyOf(req!).items[0]!.ref).sort()).toEqual(["id", "kind"]);
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

  it("at most one per agent per 30 s: a burst is batched and goes out when the window passes (fake clock)", async () => {
    const s = await setup();
    const node = s.node();
    await s.give(s.hooked);
    expect(await node.tick()).toBe(1);
    const batch: string[] = [];
    for (let i = 0; i < 5; i++) batch.push(await s.give(s.hooked));
    s.advance(10_000);
    expect(await node.tick()).toBe(0);
    batch.push(await s.give(s.hooked));
    s.advance(19_000); // 29 s since the first
    expect(await node.tick()).toBe(0);
    s.advance(1_000); // 30 s
    expect(await node.tick()).toBe(1);
    expect(bodyOf(s.sent[1]!).items.map((i) => i.id)).toEqual(batch);
    s.advance(120_000);
    expect(await node.tick()).toBe(0); // nothing new
    expect(s.sent).toHaveLength(2);
  });

  it("several nodes on one database send once: the rate limit and the items are shared", async () => {
    const s = await setup();
    const other = await s.add("AGENT", { wake_webhook_url: "https://hooks.example/agent-b" });
    await s.give(s.hooked);
    await s.give(other);
    const nodes = [s.node(), s.node(), s.node()];
    const results = await Promise.all(nodes.map((nd) => nd.tick()));
    expect(results.reduce((a, b) => a + b, 0)).toBe(2); // one delivery per agent, however many nodes
    expect(s.sent.map((r) => r.url).sort()).toEqual([
      "https://hooks.example/agent-a",
      "https://hooks.example/agent-b",
    ]);
    // And again inside the window: still nothing.
    await s.give(s.hooked);
    s.advance(5_000);
    expect((await Promise.all(nodes.map((nd) => nd.tick()))).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("an item whose transaction commits late is still announced; it isn't skipped by what was announced meanwhile", async () => {
    const s = await setup();
    const held = await pool.connect();
    await held.query("BEGIN");
    const late = await s.give(s.hooked, "MENTION", "late", held); // inserted, not yet committed
    s.advance(1_000);
    const early = await s.give(s.hooked); // committed at once
    const node = s.node();
    expect(await node.tick()).toBe(1);
    expect(bodyOf(s.sent[0]!).items.map((i) => i.id)).toEqual([early]);
    s.advance(60_000); // far past any lag a cursor could allow
    await held.query("COMMIT");
    held.release();
    expect(await node.tick()).toBe(1);
    expect(bodyOf(s.sent[1]!).items.map((i) => i.id)).toEqual([late]);
  });

  it("a restart in the middle of a window keeps the limit and loses nothing", async () => {
    const s = await setup();
    await s.give(s.hooked);
    expect(await s.node().tick()).toBe(1); // node A, then it goes away
    const second = await s.give(s.hooked);
    s.advance(10_000);
    const restarted = s.node(); // a new process: no memory of anything
    expect(await restarted.tick()).toBe(0); // the window still holds
    s.advance(20_000);
    expect(await restarted.tick()).toBe(1);
    expect(bodyOf(s.sent[1]!).items.map((i) => i.id)).toEqual([second]);
  });

  it("only agents with a webhook, active, in an active room: others are not called, and items acknowledged first are left out", async () => {
    const s = await setup();
    const human = await s.add("HUMAN", null);
    const plain = await s.add("AGENT", { name: "no url" });
    const paused = await s.add("AGENT", { wake_webhook_url: "https://hooks.example/p" }, "PAUSED");
    for (const who of [human, plain, paused]) await s.give(who);
    const node = s.node();
    expect(await node.tick()).toBe(0);
    expect(s.sent).toEqual([]);

    // A frozen room isn't called; when it is active again, the items are still there.
    const kept = await s.give(s.hooked);
    await pool.query("UPDATE rooms SET status = 'PAUSED' WHERE id = $1", [s.room]);
    expect(await node.tick()).toBe(0);
    await pool.query("UPDATE rooms SET status = 'ACTIVE' WHERE id = $1", [s.room]);
    const acked = await s.give(s.hooked);
    await pool.query("UPDATE inbox_items SET acked_at = now() WHERE id = $1", [acked]);
    expect(await node.tick()).toBe(1);
    expect(bodyOf(s.sent[0]!).items.map((i) => i.id)).toEqual([kept]);
  });

  it("a failing receiver is retried after a window that doubles, and nothing is lost or repeated", async () => {
    const s = await setup();
    const node = s.node();
    const id = await s.give(s.hooked);
    s.fail(new Error("receiver is down"));
    expect(await node.tick()).toBe(0); // fails: the window opens anyway
    s.fail(undefined);
    s.advance(30_000);
    expect(await node.tick()).toBe(0); // one failure in a row doubles the wait: 60 s
    s.advance(30_000);
    expect(await node.tick()).toBe(1);
    expect(bodyOf(s.sent[0]!).items.map((i) => i.id)).toEqual([id]);
    // Recovered: back to a 30 s window.
    await s.give(s.hooked);
    s.advance(30_000);
    expect(await node.tick()).toBe(1);
    expect(s.sent).toHaveLength(2);
  });

  it("one slow receiver delays no other agent: sends run concurrently", async () => {
    const s = await setup();
    const fast = await s.add("AGENT", { wake_webhook_url: "https://hooks.example/fast" });
    await s.give(s.hooked);
    await s.give(fast);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const delivered: string[] = [];
    s.setSender(async (request) => {
      if (request.url.endsWith("agent-a")) await gate; // the slow one
      delivered.push(request.url);
    });
    const ticking = s.node().tick();
    for (let i = 0; i < 100 && !delivered.includes("https://hooks.example/fast"); i++) {
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(delivered).toEqual(["https://hooks.example/fast"]); // while the slow one is still open
    release();
    expect(await ticking).toBe(2);
  });

  it("agents in backoff don't crowd out the others: only agents whose window is open are taken up", async () => {
    const s = await setup();
    const sick: string[] = [];
    for (let i = 0; i < 3; i++) {
      sick.push(await s.add("AGENT", { wake_webhook_url: `https://hooks.example/sick-${i}` }));
    }
    const well = await s.add("AGENT", { wake_webhook_url: "https://hooks.example/well" });
    const node = s.node({ agentsPerTick: 2 });
    for (const id of sick) await s.give(id);
    s.fail(new Error("down"));
    await node.tick();
    await node.tick(); // all three have failed once: a 60 s window each
    s.fail(undefined);
    s.advance(20_000);
    await s.give(well);
    await s.node().tick(); // the healthy agent is served once (its window row now exists, newer than theirs)
    expect(s.sent.map((r) => r.url)).toEqual(["https://hooks.example/well"]);
    await s.give(well);
    s.advance(31_000); // 51 s: theirs are still shut, the healthy one's is open
    expect(await node.tick()).toBe(1);
    expect(s.sent.map((r) => r.url)).toEqual([
      "https://hooks.example/well",
      "https://hooks.example/well",
    ]);
  });

  it("an agent is claimed right before its send: a slow send ahead of it doesn't let another node take it and double-send", async () => {
    const s = await setup();
    const other = await s.add("AGENT", { wake_webhook_url: "https://hooks.example/agent-b" });
    await s.give(s.hooked);
    await s.give(other);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const counts = new Map<string, number>();
    let heldUrl: string | undefined;
    const sender: WakeSender = async (request) => {
      counts.set(request.url, (counts.get(request.url) ?? 0) + 1);
      heldUrl ??= request.url;
      if (request.url === heldUrl && counts.get(request.url) === 1) await gate;
    };
    const slow = s.node({ concurrency: 1, sender });
    const quick = s.node({ sender });
    const running = slow.tick();
    for (let i = 0; i < 100 && counts.size === 0; i++) await new Promise((r) => setTimeout(r, 20));
    // Nothing is claimed ahead of its send: the one still waiting behind the slow send has no window yet.
    const { rows: windows } = await pool.query(
      "SELECT participant_id FROM wake_windows WHERE participant_id = ANY($1::text[]) AND last_sent_at > 'epoch'",
      [[s.hooked, other]],
    );
    expect(windows).toHaveLength(1); // only the one being sent
    // Within the send deadline (shorter than the window, which the constructor enforces), another
    // node runs: it may take the agent nobody claimed yet, but never the one being sent to.
    s.advance(9_000);
    await quick.tick();
    release();
    await running;
    const unheld = [...counts.keys()].find((url) => url !== heldUrl)!;
    expect(counts.get(unheld)).toBe(1); // sent by one node only
    expect(counts.get(heldUrl!)).toBe(1); // the one in flight wasn't sent again either
    await new Promise((r) => setTimeout(r, 0));
  });

  it("the delivery deadline must be shorter than the window, so a send never outlives its claim", () => {
    const base = { pool, key: KEY, sender: async () => undefined };
    expect(() => new WakeWebhookService({ ...base, windowMs: 10_000 })).toThrow(/shorter/);
    expect(
      () => new WakeWebhookService({ ...base, windowMs: 30_000, deliveryDeadlineMs: 30_000 }),
    ).toThrow(/shorter/);
    expect(() => new WakeWebhookService({ ...base })).not.toThrow(); // 10 s < 30 s
  });

  it("without a fake clock, windows are timed by the database clock, not a skewed node's", async () => {
    const s = await setup();
    const node = s.node({ realClock: true });
    await s.give(s.hooked);
    // This node's clock is an hour fast; the window must still be written in database time.
    const realNow = Date.now.bind(Date);
    const skewed = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 3_600_000);
    try {
      expect(await node.tick()).toBe(1);
    } finally {
      skewed.mockRestore();
    }
    const { rows } = await pool.query<{ skew: number }>(
      `SELECT abs(extract(epoch FROM (clock_timestamp() - last_sent_at))) AS skew
       FROM wake_windows WHERE participant_id = $1`,
      [s.hooked],
    );
    expect(Number(rows[0]!.skew)).toBeLessThan(5); // written from the database clock, not the fake one
    await s.give(s.hooked);
    expect(await node.tick()).toBe(0); // the window holds by the database clock
  });

  it("a database failure before the send isn't the endpoint's: no backoff, and the window is given back", async () => {
    const s = await setup();
    const id = await s.give(s.hooked);
    let failOnce = true;
    const flaky = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return (sql: string, params?: unknown[]) => {
          if (failOnce && sql.includes("SELECT id, kind, ref FROM inbox_items")) {
            failOnce = false;
            return Promise.reject(new Error("database hiccup"));
          }
          return target.query(sql, params as never);
        };
      },
    }) as Pool;
    expect(await s.node({ pool: flaky }).tick()).toBe(0);
    const { rows } = await pool.query<{ failures: number }>(
      "SELECT failures FROM wake_windows WHERE participant_id = $1",
      [s.hooked],
    );
    expect(rows[0]!.failures).toBe(0);
    expect(await s.node().tick()).toBe(1); // at once: the claim was given back, no window passed
    expect(bodyOf(s.sent[0]!).items.map((i) => i.id)).toEqual([id]);
  });

  it("a claim that finds nothing to send doesn't use up the window", async () => {
    const s = await setup();
    await s.give(s.hooked);
    // Between being picked and being read, the agent acknowledges everything.
    const acking = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop !== "query") return Reflect.get(target, prop, receiver);
        return async (sql: string, params?: unknown[]) => {
          if (sql.includes("SELECT id, kind, ref FROM inbox_items"))
            await target.query(
              "UPDATE inbox_items SET acked_at = now() WHERE participant_id = $1",
              [s.hooked],
            );
          return target.query(sql, params as never);
        };
      },
    }) as Pool;
    expect(await s.node({ pool: acking }).tick()).toBe(0);
    const fresh = await s.give(s.hooked);
    expect(await s.node().tick()).toBe(1); // no 30 s wait: the empty claim was given back
    expect(bodyOf(s.sent[0]!).items.map((i) => i.id)).toEqual([fresh]);
  });

  it("items whose recipient can never be woken are cleared from the outbox; paused ones are kept", async () => {
    const s = await setup();
    const leaving = await s.add("AGENT", { wake_webhook_url: "https://hooks.example/leaving" });
    const pausing = await s.add("AGENT", { wake_webhook_url: "https://hooks.example/pausing" });
    const unhooked = await s.give(s.hooked);
    const removed = await s.give(leaving);
    const paused = await s.give(pausing);
    await pool.query("UPDATE participants SET agent_manifest = '{}'::jsonb WHERE id = $1", [
      s.hooked,
    ]);
    await pool.query("UPDATE participants SET status = 'REMOVED' WHERE id = $1", [leaving]);
    await pool.query("UPDATE participants SET status = 'PAUSED' WHERE id = $1", [pausing]);
    expect(await s.node().tick()).toBe(0);
    const waiting = async (id: string) =>
      (
        await pool.query<{ waiting: boolean }>(
          "SELECT wake_notified_at IS NULL AS waiting FROM inbox_items WHERE id = $1",
          [id],
        )
      ).rows[0]!.waiting;
    expect(await waiting(unhooked)).toBe(false);
    expect(await waiting(removed)).toBe(false);
    expect(await waiting(paused)).toBe(true); // may resume
  });

  it("without a platform key nothing is sent and nothing piles up in the outbox", async () => {
    const s = await setup();
    const id = await s.give(s.hooked);
    expect(await s.node({ key: undefined }).tick()).toBe(0);
    expect(s.sent).toEqual([]);
    const { rows } = await pool.query<{ waiting: boolean }>(
      "SELECT wake_notified_at IS NULL AS waiting FROM inbox_items WHERE id = $1",
      [id],
    );
    expect(rows[0]!.waiting).toBe(false);
  });

  it("the longest-waiting agent is taken up first", async () => {
    const s = await setup();
    const other = await s.add("AGENT", { wake_webhook_url: "https://hooks.example/other" });
    await s.give(s.hooked);
    await s.give(other);
    // Make the id order and the waiting order disagree, so only last_sent_at can decide.
    const [first, second] = [s.hooked, other].sort();
    await pool.query(
      `INSERT INTO wake_windows (participant_id, room_id, last_sent_at, failures)
       VALUES ($1, $3, to_timestamp(2000), 0), ($2, $3, to_timestamp(1000), 0)`,
      [first, second, s.room],
    );
    expect(await s.node({ agentsPerTick: 1 }).tick()).toBe(1);
    const longestWaiting =
      second === s.hooked ? "https://hooks.example/agent-a" : "https://hooks.example/other";
    expect(s.sent.map((r) => r.url)).toEqual([longestWaiting]);
  });

  it("a long backlog goes out in batches, one per window, with `more` saying so", async () => {
    const s = await setup();
    const node = s.node({ batch: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await s.give(s.hooked));
    await node.tick();
    expect(bodyOf(s.sent[0]!)).toMatchObject({ count: 3, more: true });
    s.advance(30_000);
    await node.tick();
    expect(bodyOf(s.sent[1]!)).toMatchObject({ count: 2, more: false });
    expect([...bodyOf(s.sent[0]!).items, ...bodyOf(s.sent[1]!).items].map((i) => i.id)).toEqual(
      ids,
    );
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
