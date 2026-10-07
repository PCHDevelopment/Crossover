import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import {
  Dispatcher,
  findOrCreateUser,
  issueTokens,
  RedisEventPublisher,
  RedisEventSubscriber,
  registerInviteCommands,
  registerLeadCommands,
  registerRoomCommands,
  registerRoomEventsSubscribeCommand,
  type EventSubscriber,
  type RoomInviteSecret,
  type TokenPair,
} from "@crossover/kernel";
import { authorize } from "@crossover/policy";
import { newId, type RoomEvent } from "@crossover/protocol";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";
import type { WebSocketOptions } from "./ws.js";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";
let db: TestDatabase;
let pool: Pool;
let n = 0;
const cleanup: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
  await db.drop();
});

/** A subscriber the test drives by hand, to lose, duplicate and reorder live messages. */
class ManualSubscriber implements EventSubscriber {
  handlers = new Map<string, Set<(e: RoomEvent) => void>>();
  /** Events emitted the moment someone subscribes (before the backfill can finish). */
  onSubscribe: (emit: (e: RoomEvent) => void) => void = () => {};
  async subscribe(roomId: string, handler: (e: RoomEvent) => void) {
    const set = this.handlers.get(roomId) ?? new Set();
    this.handlers.set(roomId, set);
    set.add(handler);
    this.onSubscribe((e) => handler(e));
    return async () => void set.delete(handler);
  }
  emit(roomId: string, event: RoomEvent) {
    for (const h of this.handlers.get(roomId) ?? []) h(event);
  }
}

interface Env {
  dispatcher: Dispatcher;
  app: FastifyInstance;
  url: (room: string) => string;
  room: string;
  ownerId: string;
  owner: TokenPair;
}

async function setup(
  ws: Partial<WebSocketOptions> & { subscriber?: EventSubscriber } = {},
  withRedis = false,
): Promise<Env> {
  let publisher: RedisEventPublisher | undefined;
  let redisSub: RedisEventSubscriber | undefined;
  if (withRedis) {
    publisher = new RedisEventPublisher(REDIS_URL);
    await publisher.ready();
    redisSub = new RedisEventSubscriber(REDIS_URL);
    cleanup.push(
      () => publisher!.close(),
      () => redisSub!.close(),
    );
  }
  const dispatcher = new Dispatcher({
    pool,
    authorize,
    nodeId: `node-${++n}`,
    ...(publisher ? { publisher } : {}),
  });
  registerRoomCommands(dispatcher);
  registerInviteCommands(dispatcher);
  registerLeadCommands(dispatcher);
  registerRoomEventsSubscribeCommand(dispatcher);
  const app = buildGateway({
    dispatcher,
    pool,
    ws: {
      pollIntervalMs: 60_000,
      revalidateIntervalMs: 60_000,
      subscriber: redisSub ?? new ManualSubscriber(),
      ...ws,
    },
  });
  cleanup.push(() => app.close());
  const base = (await app.listen({ port: 0, host: "127.0.0.1" })).replace("http", "ws");

  const user = await findOrCreateUser(pool, {
    provider: "test",
    subject: `ws-${++n}`,
    display_name: "P",
  });
  const created = await dispatcher.dispatchRoomless(
    { user_id: user.id, display_name: "P" },
    {
      id: newId("cmd"),
      method: "room.create",
      params: { slug: `ws-${++n}-${Date.now().toString(36)}`, name: "n", objective: "o" },
      idempotency_key: `k-${++n}`,
    },
  );
  const { room, participant } = created.response as {
    room: { id: string };
    participant: { id: string };
  };
  return {
    dispatcher,
    app,
    url: (r) => `${base}/v1/rooms/${r}/ws`,
    room: room.id,
    ownerId: participant.id,
    owner: await issueTokens(pool, participant.id),
  };
}

// Frames are loosely typed JSON in tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Frame = Record<string, any>;

class Client {
  frames: Frame[] = [];
  closeCode: number | undefined;
  private waiters: (() => void)[] = [];
  readonly sock: WebSocket;
  constructor(url: string, token?: string) {
    this.sock = new WebSocket(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    this.sock.on("message", (d) => {
      this.frames.push(JSON.parse(d.toString()));
      this.wake();
    });
    this.sock.on("close", (code) => {
      this.closeCode = code;
      this.wake();
    });
    this.sock.on("error", () => this.wake());
    cleanup.push(() => this.sock.terminate());
  }
  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }
  async until(cond: () => boolean, label = "condition", ms = 4000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${label}; frames=${JSON.stringify(this.frames).slice(0, 600)} close=${this.closeCode}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }
  open = () => this.until(() => this.sock.readyState === WebSocket.OPEN, "open");
  send = (f: Frame) => this.sock.send(JSON.stringify(f));
  raw = (s: string) => this.sock.send(s);
  frame = async (type: string, from = 0): Promise<Frame> => {
    await this.until(() => this.frames.slice(from).some((f) => f.type === type), `a ${type} frame`);
    return this.frames.slice(from).find((f) => f.type === type)!;
  };
  events = () => this.frames.filter((f) => f.type === "event").map((f) => f.event as RoomEvent);
  sequences = () => this.events().map((e) => e.sequence);
  closed = async () => {
    await this.until(() => this.closeCode !== undefined, "close");
    return this.closeCode!;
  };
}

const hello = (extra: Frame = {}): Frame => ({
  type: "hello",
  protocol_version: 1,
  client: "test",
  client_version: "1",
  ...extra,
});
const cmd = (method: string, params: Frame = {}, extra: Frame = {}): Frame => ({
  type: "command",
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `k-${++n}`,
  ...extra,
});

async function ready(env: Env, token: string = env.owner.access_token): Promise<Client> {
  const c = new Client(env.url(env.room), token);
  await c.open();
  c.send(hello());
  await c.frame("hello_ok");
  return c;
}

/** Commit events through the dispatcher and return them. */
async function invite(env: Env, count = 1): Promise<RoomEvent[]> {
  const out: RoomEvent[] = [];
  for (let i = 0; i < count; i++) {
    const r = await env.dispatcher.dispatch(
      {
        participant_id: env.ownerId,
        room_id: env.room,
        kind: "HUMAN",
        authority: "OWNER",
        role: "LEAD",
      },
      {
        id: newId("cmd"),
        method: "room.invite",
        params: { role: "DEVELOPER" },
        idempotency_key: `k-${++n}`,
      },
    );
    out.push(...r.events);
  }
  return out;
}

describe("hello and negotiation (§16.4)", () => {
  it("answers hello with the negotiated version and who you are", async () => {
    const env = await setup();
    const c = new Client(env.url(env.room), env.owner.access_token);
    await c.open();
    c.send(hello());
    expect(await c.frame("hello_ok")).toMatchObject({
      protocol_version: 1,
      participant_id: env.ownerId,
      room_id: env.room,
    });
  });

  it("accepts the token in hello when the client can't set headers", async () => {
    const env = await setup();
    const c = new Client(env.url(env.room));
    await c.open();
    c.send(hello({ token: env.owner.access_token }));
    await c.frame("hello_ok");
  });

  it.each([
    ["an unsupported version", { protocol_version: 2 }],
    ["a non-numeric version", { protocol_version: "1" }],
    ["a missing client", { client: undefined }],
    ["an empty client_version", { client_version: "" }],
  ])("%s → error and close 4400", async (_n, extra) => {
    const env = await setup();
    const c = new Client(env.url(env.room), env.owner.access_token);
    await c.open();
    c.send({ ...hello(), ...extra });
    const err = await c.frame("error");
    expect(err.error).toMatchObject({ code: "VALIDATION" });
    expect(await c.closed()).toBe(4400);
    if ("protocol_version" in extra && extra.protocol_version === 2) {
      expect(err.error.details).toEqual({ supported: [1] });
    }
  });

  it("anything before hello is refused and closes the connection", async () => {
    const env = await setup();
    const c = new Client(env.url(env.room), env.owner.access_token);
    await c.open();
    c.send(cmd("room.get_state"));
    expect((await c.frame("error")).error.code).toBe("VALIDATION");
    expect(await c.closed()).toBe(4400);
  });

  it.each([
    ["no token", undefined],
    ["an unknown token", "at_nope"],
    ["a refresh token", "rt_nope"],
  ])("%s → UNAUTHENTICATED and close 4401", async (_n, token) => {
    const env = await setup();
    const c = new Client(env.url(env.room), token);
    await c.open();
    c.send(hello());
    expect((await c.frame("error")).error.code).toBe("UNAUTHENTICATED");
    expect(await c.closed()).toBe(4401);
  });

  it("a token for another room looks like a room that doesn't exist (4404)", async () => {
    const a = await setup();
    const b = await setup();
    const c = new Client(a.url(b.room), a.owner.access_token);
    await c.open();
    c.send(hello());
    expect((await c.frame("error")).error.code).toBe("NOT_FOUND");
    expect(await c.closed()).toBe(4404);
  });

  it("closes a connection that never says hello", async () => {
    const env = await setup({ helloTimeoutMs: 100 });
    const c = new Client(env.url(env.room), env.owner.access_token);
    await c.open();
    expect(await c.closed()).toBe(4408);
  });

  it("a second hello and unknown or malformed frames get errors but keep the connection", async () => {
    const env = await setup();
    const c = await ready(env);
    c.send(hello());
    c.send({ type: "dance" });
    c.raw("not json");
    c.raw("[1,2]");
    await c.until(() => c.frames.filter((f) => f.type === "error").length === 4, "four errors");
    expect(c.closeCode).toBeUndefined();
    c.send(cmd("room.get_state"));
    await c.frame("result");
  });

  it("only upgrades the ws path", async () => {
    const env = await setup();
    const c = new Client(env.url(env.room).replace("/ws", "/nope"), env.owner.access_token);
    await c.until(() => c.sock.readyState >= WebSocket.CLOSING, "rejection");
    expect(c.sock.readyState).not.toBe(WebSocket.OPEN);
  });
});

describe("command frames: the same semantics as REST", () => {
  it("runs a command and returns result with response, events, replayed and the one-time secret", async () => {
    const env = await setup();
    const c = await ready(env);
    const frame = cmd("room.invite", { role: "DEVELOPER" });
    c.send(frame);
    const res = await c.frame("result");
    expect(res).toMatchObject({ id: frame.id, replayed: false });
    expect(res.response).toMatchObject({ role: "DEVELOPER" });
    expect(res.events.map((e: RoomEvent) => e.type)).toEqual(["participant.invited"]);
    expect((res.one_time as RoomInviteSecret).token).toMatch(/^inv_/);
  });

  it("an idempotent retry replays without the secret", async () => {
    const env = await setup();
    const c = await ready(env);
    const frame = cmd("room.invite", { role: "DEVELOPER" }, { idempotency_key: "same" });
    c.send(frame);
    await c.frame("result");
    c.send({ ...frame, id: newId("cmd") });
    await c.until(() => c.frames.filter((f) => f.type === "result").length === 2, "two results");
    const second = c.frames.filter((f) => f.type === "result")[1]!;
    expect(second.replayed).toBe(true);
    expect(second.one_time).toBeUndefined();
  });

  it("errors come back as error frames with the id and the §16.3 body; the connection stays open", async () => {
    const env = await setup();
    const c = await ready(env);
    const bad = cmd("room.invite", { role: "LEAD" });
    c.send(bad);
    const err = await c.frame("error");
    expect(err).toMatchObject({ id: bad.id, error: { code: "VALIDATION", retryable: false } });
    const unknown = cmd("nothing.here");
    c.send(unknown);
    await c.until(
      () => c.frames.some((f) => f.type === "error" && f.id === unknown.id),
      "unknown method",
    );
    expect(c.frames.find((f) => f.id === unknown.id)!.error.code).toBe("NOT_FOUND");
    expect(c.closeCode).toBeUndefined();
  });

  it("a command needs a cmd_ id and a method", async () => {
    const env = await setup();
    const c = await ready(env);
    c.send({ type: "command", id: "x", method: "room.get_state", params: {} });
    c.send({ type: "command", id: newId("cmd"), params: {} });
    await c.until(() => c.frames.filter((f) => f.type === "error").length === 2, "two errors");
    expect(
      c.frames.filter((f) => f.type === "error").every((f) => f.error.code === "VALIDATION"),
    ).toBe(true);
  });

  it("is authorized like any command: a developer can't invite", async () => {
    const env = await setup();
    const inv = await env.dispatcher.dispatch(
      {
        participant_id: env.ownerId,
        room_id: env.room,
        kind: "HUMAN",
        authority: "OWNER",
        role: "LEAD",
      },
      {
        id: newId("cmd"),
        method: "room.invite",
        params: { role: "DEVELOPER" },
        idempotency_key: `k-${++n}`,
      },
    );
    const dev = await newDeveloper(env, inv);
    const c = await ready(env, dev);
    const frame = cmd("room.invite", { role: "DEVELOPER" });
    c.send(frame);
    const err = await c.frame("error");
    expect(err).toMatchObject({
      id: frame.id,
      error: { code: "FORBIDDEN", details: { missing_capability: "room.invite" } },
    });
  });

  it("commands on one connection run in the order sent", async () => {
    const env = await setup();
    const c = await ready(env);
    const frames = Array.from({ length: 5 }, () => cmd("room.invite", { role: "DEVELOPER" }));
    for (const f of frames) c.send(f);
    await c.until(() => c.frames.filter((f) => f.type === "result").length === 5, "five results");
    expect(c.frames.filter((f) => f.type === "result").map((f) => f.id)).toEqual(
      frames.map((f) => f.id),
    );
    const seqs = c.frames.filter((f) => f.type === "result").map((f) => f.events[0].sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

const joinRegistered = new WeakSet<Dispatcher>();

async function newDeveloper(env: Env, inv: { one_time?: unknown }): Promise<string> {
  const token = (inv.one_time as RoomInviteSecret).token;
  const joined = await (async () => {
    const { registerJoinCommand } = await import("@crossover/kernel");
    if (!joinRegistered.has(env.dispatcher)) {
      joinRegistered.add(env.dispatcher);
      registerJoinCommand(env.dispatcher);
    }
    return env.dispatcher.dispatchAnonymous(
      "room.join",
      {
        token,
        manifest: {
          name: "Dev",
          operator: { name: "P", contact: "p@example.com" },
          vendor: "v",
          model: "m",
          client: "mcp",
          client_version: "1",
          description: "d",
        },
      },
      env.room,
    );
  })();
  return (joined.one_time as TokenPair).access_token;
}

describe("subscribe: ordered, exactly-once events", () => {
  it("backfills history from PostgreSQL in order, then streams live events", async () => {
    const env = await setup();
    await invite(env, 3);
    const c = await ready(env);
    c.send({ type: "subscribe", after: 0 });
    expect(await c.frame("subscribed")).toMatchObject({ after: 0, last_sequence: 5 });
    await c.until(() => c.sequences().length === 5, "history");
    expect(c.sequences()).toEqual([1, 2, 3, 4, 5]);
  });

  it("after=N skips what the client already has", async () => {
    const env = await setup();
    await invite(env, 4);
    const c = await ready(env);
    c.send({ type: "subscribe", after: 4 });
    await c.frame("subscribed");
    await c.until(() => c.sequences().length === 2, "events 5 and 6");
    expect(c.sequences()).toEqual([5, 6]);
  });

  it("redacts capability.denied for other participants, on the live stream and in the backfill", async () => {
    const env = await setup({}, true);
    const inviteResult = () =>
      env.dispatcher.dispatch(
        {
          participant_id: env.ownerId,
          room_id: env.room,
          kind: "HUMAN",
          authority: "OWNER",
          role: "LEAD",
        },
        {
          id: newId("cmd"),
          method: "room.invite",
          params: { role: "DEVELOPER" },
          idempotency_key: `k-${++n}`,
        },
      );
    const devA = await newDeveloper(env, await inviteResult());
    const devB = await newDeveloper(env, await inviteResult());
    const denied = async () => {
      const c = await ready(env, devA);
      c.send(cmd("room.invite", { role: "DEVELOPER" }));
      expect((await c.frame("error")).error.code).toBe("FORBIDDEN");
      (c as unknown as { sock: { terminate(): void } }).sock.terminate();
    };
    await denied(); // recorded before anyone subscribes: reaches them through the backfill

    const watch = async (token: string) => {
      const c = await ready(env, token);
      c.send({ type: "subscribe", after: 0 });
      await c.frame("subscribed");
      await c.until(() => c.events().some((e) => e.type === "capability.denied"), "a denial");
      return c;
    };
    const asOwner = await watch(env.owner.access_token);
    const asA = await watch(devA);
    const asB = await watch(devB);
    const denial = (c: Client) => c.events().find((e) => e.type === "capability.denied")!;
    expect(denial(asOwner).payload).not.toHaveProperty("resource_redacted");
    expect(denial(asA).payload).not.toHaveProperty("resource_redacted"); // it is about them
    expect(denial(asB).payload).toMatchObject({ resource_redacted: true });
    expect(denial(asB).payload).not.toHaveProperty("resource");

    // And live: a second denial after everyone is subscribed.
    const before = asB.events().filter((e) => e.type === "capability.denied").length;
    await denied();
    await asB.until(
      () => asB.events().filter((e) => e.type === "capability.denied").length === before + 1,
      "a live denial",
    );
    const live = asB
      .events()
      .filter((e) => e.type === "capability.denied")
      .at(-1)!;
    expect(live.payload).toMatchObject({ resource_redacted: true });
    expect(live.payload).not.toHaveProperty("resource");
    await asOwner.until(
      () => asOwner.events().filter((e) => e.type === "capability.denied").length === 2,
      "the owner's live denial",
    );
    expect(asOwner.events().at(-1)!.payload).not.toHaveProperty("resource_redacted");
  });

  it("a lead who is demoted stops seeing denials in full, once the token is revalidated", async () => {
    const env = await setup({ revalidateIntervalMs: 50 }, true);
    const owner = {
      participant_id: env.ownerId,
      room_id: env.room,
      kind: "HUMAN" as const,
      authority: "OWNER" as const,
      role: "LEAD" as const,
    };
    const asOwner = (method: string, params: Frame) =>
      env.dispatcher.dispatch(owner, {
        id: newId("cmd"),
        method,
        params,
        idempotency_key: `k-${++n}`,
      });
    const join = async () => newDeveloper(env, await asOwner("room.invite", { role: "DEVELOPER" }));
    const [lead, other, offender] = [await join(), await join(), await join()];

    const watcher = await ready(env, lead);
    const leadId = (watcher.frames.find((f) => f.type === "hello_ok") as Frame).participant_id;
    await asOwner("room.set_lead", { participant_id: leadId });
    watcher.send({ type: "subscribe", after: 0 });
    await watcher.frame("subscribed");

    const deny = async () => {
      const c = await ready(env, offender);
      c.send(cmd("room.invite", { role: "DEVELOPER" }));
      expect((await c.frame("error")).error.code).toBe("FORBIDDEN");
      (c as unknown as { sock: { terminate(): void } }).sock.terminate();
    };
    const denials = () => watcher.events().filter((e) => e.type === "capability.denied");

    await deny();
    await watcher.until(() => denials().length === 1, "the first denial");
    expect(denials()[0]!.payload).not.toHaveProperty("resource_redacted"); // the lead sees it

    // Demote: someone else becomes the lead. Wait out several revalidation intervals.
    const otherId = (await ready(env, other)).frames.find(
      (f) => f.type === "hello_ok",
    )!.participant_id;
    await asOwner("room.set_lead", { participant_id: otherId });
    await new Promise((r) => setTimeout(r, 400));

    await deny();
    await watcher.until(() => denials().length === 2, "the second denial");
    expect(denials()[1]!.payload).toMatchObject({ resource_redacted: true });
    expect(denials()[1]!.payload).not.toHaveProperty("resource");
  });

  it("is refused without room.read (a paused participant), with an error frame", async () => {
    const env = await setup();
    const inv = await env.dispatcher.dispatch(
      {
        participant_id: env.ownerId,
        room_id: env.room,
        kind: "HUMAN",
        authority: "OWNER",
        role: "LEAD",
      },
      {
        id: newId("cmd"),
        method: "room.invite",
        params: { role: "DEVELOPER" },
        idempotency_key: `k-${++n}`,
      },
    );
    const dev = await newDeveloper(env, inv);
    await pool.query(
      "UPDATE participants SET status = 'PAUSED' WHERE room_id = $1 AND kind = 'AGENT'",
      [env.room],
    );
    const c = await ready(env, dev);
    c.send({ type: "subscribe", after: 0 });
    expect((await c.frame("error")).error.code).toBe("PARTICIPANT_PAUSED");
    expect(c.frames.some((f) => f.type === "event")).toBe(false);
  });

  it("rejects a bad after", async () => {
    const env = await setup();
    const c = await ready(env);
    for (const after of [-1, "x", 1.5]) c.send({ type: "subscribe", after });
    await c.until(() => c.frames.filter((f) => f.type === "error").length === 3, "three errors");
  });

  it("never sends another room's events", async () => {
    const a = await setup();
    const b = await setup();
    await invite(a, 2);
    await invite(b, 3);
    const c = await ready(a);
    c.send({ type: "subscribe", after: 0 });
    await c.until(() => c.sequences().length === 4, "a's history");
    expect(new Set(c.events().map((e) => e.room_id))).toEqual(new Set([a.room]));
  });

  it("subscribing again restarts the stream from the new after", async () => {
    const env = await setup();
    await invite(env, 3);
    const c = await ready(env);
    c.send({ type: "subscribe", after: 0 });
    await c.until(() => c.sequences().length === 5, "all");
    const mark = c.frames.length;
    c.send({ type: "subscribe", after: 3 });
    await c.until(
      () => c.frames.slice(mark).filter((f) => f.type === "event").length === 2,
      "4 and 5 again",
    );
    expect(
      c.frames
        .slice(mark)
        .filter((f) => f.type === "event")
        .map((f) => f.event.sequence),
    ).toEqual([4, 5]);
  });
});

describe("a client that misses Redis messages still gets every event, in order (T703)", () => {
  it("a dropped message in the middle: the next live event triggers a backfill of the gap", async () => {
    const sub = new ManualSubscriber();
    const env = await setup({ subscriber: sub });
    const c = await ready(env);
    c.send({ type: "subscribe", after: 0 });
    await c.frame("subscribed");
    await c.until(() => c.sequences().length === 2, "the two creation events");
    const events = await invite(env, 4);
    // Deliver every message except the second.
    for (const [i, e] of events.entries()) if (i !== 1) sub.emit(env.room, e);
    await c.until(() => c.sequences().length === 6, "all four new events");
    expect(c.sequences()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("the final message dropped: the poll delivers it", async () => {
    const sub = new ManualSubscriber();
    const env = await setup({ subscriber: sub, pollIntervalMs: 80 });
    const c = await ready(env);
    c.send({ type: "subscribe", after: 0 });
    await c.frame("subscribed");
    const before = c.sequences().length;
    const events = await invite(env, 2);
    sub.emit(env.room, events[0]!); // the last one is lost
    await c.until(
      () => c.sequences().length === before + 2 + (c.sequences().length - before - 2),
      "events",
    );
    await c.until(
      () => c.sequences().includes(events[1]!.sequence),
      "the dropped final event via the poll",
    );
    expect(c.sequences()).toEqual([...c.sequences()].sort((a, b) => a - b));
    expect(new Set(c.sequences()).size).toBe(c.sequences().length);
  });

  it("duplicated and out-of-order messages arrive once, in order", async () => {
    const sub = new ManualSubscriber();
    const env = await setup({ subscriber: sub });
    const c = await ready(env);
    c.send({ type: "subscribe", after: 0 });
    await c.frame("subscribed");
    const events = await invite(env, 4);
    for (const i of [2, 0, 0, 3, 1, 2, 3]) sub.emit(env.room, events[i]!);
    await c.until(() => c.sequences().includes(events[3]!.sequence), "the last event");
    const seqs = c.sequences();
    expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
    expect(seqs.at(-1)).toBe(events[3]!.sequence);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });

  it("live events arriving during the backfill are neither lost nor duplicated", async () => {
    const sub = new ManualSubscriber();
    const env = await setup({ subscriber: sub, backfillPageSize: 2 });
    const history = await invite(env, 6);
    // The moment the client subscribes, deliver the newest event, ahead of the backfill.
    sub.onSubscribe = (emit) => emit(history[5]!);
    const c = await ready(env);
    c.send({ type: "subscribe", after: 0 });
    await c.until(() => c.sequences().length >= 8, "everything");
    expect(c.sequences()).toEqual(Array.from({ length: c.sequences().length }, (_, i) => i + 1));
  });

  it("works end to end over real Redis: published events reach the client in order", async () => {
    const env = await setup({}, true);
    const c = await ready(env);
    c.send({ type: "subscribe", after: 0 });
    await c.frame("subscribed");
    await c.until(() => c.sequences().length === 2, "the two creation events");
    const events = await invite(env, 5);
    await c.until(() => c.sequences().includes(events[4]!.sequence), "published events");
    expect(c.sequences()).toEqual([1, 2, ...events.map((e) => e.sequence)]);
    expect(new Set(c.sequences()).size).toBe(c.sequences().length);
  });

  it("two clients each get the full ordered stream", async () => {
    const env = await setup({}, true);
    const [a, b] = [await ready(env), await ready(env)];
    for (const c of [a, b]) {
      c.send({ type: "subscribe", after: 0 });
      await c.frame("subscribed");
    }
    const events = await invite(env, 3);
    for (const c of [a, b])
      await c.until(() => c.sequences().includes(events[2]!.sequence), "events");
    expect(a.sequences()).toEqual(b.sequences());
  });
});

describe("backpressure and token lifetime (§20)", () => {
  it("a client that falls too far behind is closed with resync_required", async () => {
    const sub = new ManualSubscriber();
    const env = await setup({ subscriber: sub, maxBufferedEvents: 2, backfillPageSize: 1 });
    const history = await invite(env, 8);
    sub.onSubscribe = (emit) => {
      for (const e of history.slice(0, 6)) emit(e);
    };
    const c = await ready(env);
    c.send({ type: "subscribe", after: 0 });
    await c.frame("resync_required");
    expect(await c.closed()).toBe(4409);
  });

  it("closes the socket once the participant's token stops working", async () => {
    const env = await setup({ revalidateIntervalMs: 60 });
    const c = await ready(env);
    await pool.query("UPDATE participants SET status = 'REMOVED' WHERE id = $1", [env.ownerId]);
    expect(await c.closed()).toBe(4401);
  });

  it("closes cleanly when the server shuts down", async () => {
    const env = await setup();
    const c = await ready(env);
    await env.app.close();
    expect(await c.closed()).toBe(1001);
  });
});
