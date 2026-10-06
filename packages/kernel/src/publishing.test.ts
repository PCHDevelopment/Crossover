import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { CrossoverError, newId, roomEventSchema, type RoomEvent } from "@crossover/protocol";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { allowAll, Dispatcher, type DispatcherOptions } from "./dispatcher.js";
import type { Principal } from "./principal.js";
import { RedisEventPublisher, roomChannel, type EventPublisher } from "./publisher.js";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

let db: TestDatabase;
let pool: Pool;
let counter = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  await db.drop();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function newRoom(): Promise<string> {
  const id = `room_${++counter}`;
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'part_1')`,
    [id],
  );
  return id;
}

const principal = (room_id: string): Principal => ({
  participant_id: "part_1",
  room_id,
  kind: "HUMAN",
  authority: "MEMBER",
  role: "DEVELOPER",
});
let keyN = 0;
const envelope = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `k-${++keyN}`,
});

/** A dispatcher with `messages.send` (emits `n` events) and a read command. */
function setup(publisher: EventPublisher | undefined, extra: Partial<DispatcherOptions> = {}) {
  const errors: unknown[] = [];
  const d = new Dispatcher({
    pool,
    authorize: allowAll,
    nodeId: `node-${++counter}`,
    ...(publisher ? { publisher } : {}),
    onPublishError: (error) => void errors.push(error),
    ...extra,
  });
  d.registerCommand({
    method: "messages.send",
    params: z.object({ n: z.number().int().min(0).default(1), fail: z.boolean().default(false) }),
    mutating: true,
    execute: async (_ctx, p) => {
      if (p.fail) throw new Error("boom");
      return {
        response: { n: p.n },
        events: Array.from({ length: p.n }, (_, i) => ({
          type: "message.sent" as const,
          payload: { i },
        })),
      };
    },
  });
  d.registerCommand({
    method: "room.get_state",
    params: z.object({}),
    mutating: false,
    execute: async () => ({ response: "state" }),
  });
  return { d, errors };
}

class Recorder implements EventPublisher {
  readonly calls: { roomId: string; events: RoomEvent[] }[] = [];
  async publish(roomId: string, events: readonly RoomEvent[]): Promise<void> {
    this.calls.push({ roomId, events: [...events] });
  }
}

describe("Dispatcher publishing", () => {
  it("publishes a committed command's events, in order, to the room", async () => {
    const room = await newRoom();
    const rec = new Recorder();
    const { d } = setup(rec);
    const out = await d.dispatch(principal(room), envelope("messages.send", { n: 3 }));
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.roomId).toBe(room);
    expect(rec.calls[0]!.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(rec.calls[0]!.events).toEqual(out.events);
  });

  it("publishes only after the commit: subscribers can read the events back", async () => {
    const room = await newRoom();
    let visible = -1;
    const publisher: EventPublisher = {
      publish: async (roomId) => {
        // A different connection only sees committed rows.
        visible =
          (await pool.query("SELECT 1 FROM events WHERE room_id = $1", [roomId])).rowCount ?? -1;
      },
    };
    const { d } = setup(publisher);
    await d.dispatch(principal(room), envelope("messages.send", { n: 2 }));
    expect(visible).toBe(2);
  });

  it("no publish happens for a rolled-back command", async () => {
    const rec = new Recorder();
    const { d } = setup(rec);
    // execute throws
    await expect(
      d.dispatch(principal(await newRoom()), envelope("messages.send", { fail: true })),
    ).rejects.toThrow("boom");
    // the ledger rejects the event
    const bad = setup(rec);
    bad.d.registerCommand({
      method: "messages.edit",
      params: z.object({}),
      mutating: true,
      execute: async () => ({ response: 1, events: [{ type: "task.exploded" as never }] }),
    });
    await expect(
      bad.d.dispatch(principal(await newRoom()), envelope("messages.edit")),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    // authorization denies
    const denied = setup(rec, {
      authorize: async () => {
        throw new CrossoverError("FORBIDDEN", "no");
      },
    });
    await expect(
      denied.d.dispatch(principal(await newRoom()), envelope("messages.send")),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Only the denial itself is published (T215), not anything the command would have done.
    expect(rec.calls.flatMap((c) => c.events.map((e) => e.type))).toEqual(["capability.denied"]);
  });

  it("doesn't publish again for an idempotent replay", async () => {
    const room = await newRoom();
    const rec = new Recorder();
    const { d } = setup(rec);
    const env = envelope("messages.send", { n: 2 });
    await d.dispatch(principal(room), env);
    const again = await d.dispatch(principal(room), env);
    expect(again.replayed).toBe(true);
    expect(rec.calls).toHaveLength(1);
  });

  it("doesn't publish for reads or for commands without events", async () => {
    const room = await newRoom();
    const rec = new Recorder();
    const { d } = setup(rec);
    await d.dispatch(principal(room), { id: newId("cmd"), method: "room.get_state", params: {} });
    await d.dispatch(principal(room), envelope("messages.send", { n: 0 }));
    expect(rec.calls).toEqual([]);
  });

  it("publishes in sequence order across concurrent commands for one room", async () => {
    const room = await newRoom();
    const rec = new Recorder();
    const { d } = setup(rec);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        d.dispatch(principal(room), envelope("messages.send", { n: 2 })),
      ),
    );
    const sequences = rec.calls.flatMap((c) => c.events.map((e) => e.sequence));
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("publishes after the command's afterCommit callbacks", async () => {
    const room = await newRoom();
    const log: string[] = [];
    const publisher: EventPublisher = { publish: async () => void log.push("publish") };
    const { d } = setup(publisher);
    d.registerCommand({
      method: "messages.edit",
      params: z.object({}),
      mutating: true,
      execute: async (ctx) => {
        ctx.afterCommit(async () => {
          await sleep(20);
          log.push("ref-update");
        });
        return { response: null, events: [{ type: "message.edited" as const }] };
      },
    });
    await d.dispatch(principal(room), envelope("messages.edit"));
    expect(log).toEqual(["ref-update", "publish"]);
  });

  describe("a publish failure never fails the command", () => {
    it("rejects → reported, command succeeds, data committed, queue continues", async () => {
      const room = await newRoom();
      const boom = new Error("redis exploded");
      const { d, errors } = setup({
        publish: async () => {
          throw boom;
        },
      });
      const out = await d.dispatch(principal(room), envelope("messages.send", { n: 2 }));
      expect(out.response).toEqual({ n: 2 });
      expect(errors).toEqual([boom]);
      expect((await pool.query("SELECT 1 FROM events WHERE room_id = $1", [room])).rowCount).toBe(
        2,
      );
      // the room's actor isn't wedged
      await expect(d.dispatch(principal(room), envelope("messages.send"))).resolves.toBeTruthy();
    });

    it("hangs → times out, reported, command succeeds", async () => {
      const room = await newRoom();
      const { d, errors } = setup(
        { publish: () => new Promise<void>(() => {}) },
        { publishTimeoutMs: 100 },
      );
      const started = Date.now();
      const out = await d.dispatch(principal(room), envelope("messages.send"));
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(out.events).toHaveLength(1);
      expect(String((errors[0] as Error).message)).toMatch(/timed out after 100 ms/);
    });

    it("a throwing error handler doesn't fail the command either", async () => {
      const room = await newRoom();
      const { d } = setup(
        {
          publish: async () => {
            throw new Error("x");
          },
        },
        {
          onPublishError: () => {
            throw new Error("handler broke");
          },
        },
      );
      await expect(d.dispatch(principal(room), envelope("messages.send"))).resolves.toBeTruthy();
    });
  });

  it("works without a publisher", async () => {
    const room = await newRoom();
    const { d } = setup(undefined);
    await expect(d.dispatch(principal(room), envelope("messages.send"))).resolves.toBeTruthy();
  });
});

describe("RedisEventPublisher", () => {
  async function subscribe(channels: string[]) {
    const sub = new Redis(REDIS_URL);
    const received: { channel: string; event: RoomEvent }[] = [];
    sub.on("message", (channel, message) =>
      received.push({ channel, event: roomEventSchema.parse(JSON.parse(message)) }),
    );
    await sub.subscribe(...channels);
    return { sub, received };
  }

  const waitFor = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await sleep(10);
  };

  it("publishes each event as a JSON message on room:{roomId}, in order", async () => {
    const room = await newRoom();
    const { sub, received } = await subscribe([roomChannel(room)]);
    const publisher = new RedisEventPublisher(REDIS_URL);
    await publisher.ready();
    try {
      const { d } = setup(publisher);
      const out = await d.dispatch(principal(room), envelope("messages.send", { n: 3 }));
      await waitFor(() => received.length === 3);
      expect(received.map((r) => r.channel)).toEqual([
        `room:${room}`,
        `room:${room}`,
        `room:${room}`,
      ]);
      expect(received.map((r) => r.event)).toEqual(out.events);
      expect(received.map((r) => r.event.sequence)).toEqual([1, 2, 3]);
      expect(received[0]!.event.causation_id).toBe(out.events[0]!.causation_id);
    } finally {
      sub.disconnect();
      await publisher.close();
    }
  });

  it("keeps rooms on separate channels", async () => {
    const [a, b] = [await newRoom(), await newRoom()];
    const { sub, received } = await subscribe([roomChannel(a)]);
    const publisher = new RedisEventPublisher(REDIS_URL);
    await publisher.ready();
    try {
      const { d } = setup(publisher);
      await d.dispatch(principal(b), envelope("messages.send", { n: 2 }));
      await d.dispatch(principal(a), envelope("messages.send", { n: 1 }));
      await waitFor(() => received.length >= 1);
      await sleep(100);
      expect(received).toHaveLength(1);
      expect(received[0]!.channel).toBe(`room:${a}`);
    } finally {
      sub.disconnect();
      await publisher.close();
    }
  });

  it("publishes nothing for an empty list", async () => {
    const publisher = new RedisEventPublisher(REDIS_URL);
    try {
      await expect(publisher.publish("room_x", [])).resolves.toBeUndefined();
    } finally {
      await publisher.close();
    }
  });

  it("ready() resolves once connected, and rejects when Redis is unreachable", async () => {
    const up = new RedisEventPublisher(REDIS_URL);
    await up.ready();
    await up.ready(); // already ready: immediate
    await up.close();
    const down = new RedisEventPublisher("redis://127.0.0.1:1");
    await expect(down.ready(300)).rejects.toThrow(/not ready after 300 ms/);
    await down.close();
  });

  it("can share a caller's client without closing it", async () => {
    const client = new Redis(REDIS_URL);
    const publisher = new RedisEventPublisher(client);
    await publisher.close();
    expect(await client.ping()).toBe("PONG"); // still usable
    client.disconnect();
  });

  it("Redis down → publish fails fast, and the command still succeeds", async () => {
    const room = await newRoom();
    // Port 1: nothing listens there.
    const publisher = new RedisEventPublisher("redis://127.0.0.1:1");
    try {
      const started = Date.now();
      await expect(publisher.publish(room, [])).resolves.toBeUndefined(); // empty: no I/O
      const { d, errors } = setup(publisher);
      const out = await d.dispatch(principal(room), envelope("messages.send", { n: 2 }));
      expect(out.response).toEqual({ n: 2 });
      expect(errors).toHaveLength(1); // reported, not thrown
      expect(Date.now() - started).toBeLessThan(3_000); // didn't hang on the offline connection
      expect((await pool.query("SELECT 1 FROM events WHERE room_id = $1", [room])).rowCount).toBe(
        2,
      );
      // and the next command isn't held up
      await expect(d.dispatch(principal(room), envelope("messages.send"))).resolves.toBeTruthy();
    } finally {
      await publisher.close();
    }
  });
});
