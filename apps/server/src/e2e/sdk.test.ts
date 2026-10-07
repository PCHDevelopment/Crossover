import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import {
  CrossoverClient,
  CrossoverError,
  type RoomTokens,
  type SdkEvent,
  type WebSocketCtor,
} from "@crossover/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

/** The TypeScript SDK (T1101) against a real server: REST, WebSocket, and a stream that survives drops. */

let db: TestDatabase;
let root: string;
let server: CrossoverServer;
let baseUrl: string;
let serial = 0;
const sockets: { close(code?: number): void }[] = [];

/** The global WebSocket, with every instance remembered so a test can cut the connection. */
const TrackedWebSocket = class
  extends (globalThis as unknown as { WebSocket: WebSocketCtor }).WebSocket
{
  constructor(url: string) {
    super(url);
    sockets.push(this);
  }
} as unknown as WebSocketCtor;

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-sdk-e2e-"));
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `sdk-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
  };
  // The real Redis publisher and subscriber: live events travel the way they do in production.
  server = await composeServer(config, { pool: db.pool });
  baseUrl = await server.app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await server?.close();
  await db?.drop();
  await rm(root, { recursive: true, force: true });
});

async function newRoom(client = new CrossoverClient({ baseUrl, WebSocket: TrackedWebSocket })) {
  const session = await client.devLogin({
    subject: `sdk-${++serial}-${Date.now()}`,
    display_name: "Owner",
  });
  const created = await client.createRoom(session.session_token, {
    slug: `sdk-${serial}-${Date.now()}`,
    name: "SDK",
    objective: "Be called",
  });
  const roomId = created.response.room.id;
  const owner = client.room(
    roomId,
    (await client.roomSession(session.session_token, roomId)).tokens.access_token,
  );
  const invite = await owner.api.room.invite<{ role: string }>({ role: "DEVELOPER" });
  const joined = await client.join(roomId, {
    token: (invite.one_time as { token: string }).token,
    manifest: {
      name: "Dev",
      operator: { name: "P", contact: "p@example.com" },
      vendor: "Anthropic",
      model: "m",
      client: "sdk-ts",
      client_version: "1",
      description: "d",
    },
  });
  const dev = client.room(roomId, joined.tokens.access_token);
  return {
    client,
    roomId,
    owner,
    dev,
    devTokens: joined.tokens,
    devId: joined.participant_id as string | undefined,
  };
}

const lastSequence = async (room: ReturnType<CrossoverClient["room"]>) => {
  const out = (await room.api.room.events.list<{ events: SdkEvent[] }>({ limit: 500 })).response
    .events;
  return out[out.length - 1]!.sequence;
};

describe("SDK against a real server", () => {
  it("calls commands over REST as typed methods; a repeated idempotency key replays, an error is a CrossoverError", async () => {
    const r = await newRoom();
    const first = await r.dev.api.messages.send({ body: "hello" }, { idempotencyKey: "k-1" });
    expect(first.replayed).toBe(false);
    const again = await r.dev.api.messages.send({ body: "hello" }, { idempotencyKey: "k-1" });
    expect(again.replayed).toBe(true);
    expect(again.response).toEqual(first.response);
    const listed = await r.owner.api.messages.list<{ messages: { body: string }[] }>();
    expect(listed.response.messages.map((m) => m.body)).toEqual(["hello"]);

    const denied = await r.dev.api.events
      .redact({ sequence: 1, reason: "x" })
      .catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(CrossoverError);
    expect(denied).toMatchObject({ code: "FORBIDDEN", retryable: false });
  });

  it("a response lost on the way back is retried with the same key and the command runs once", async () => {
    let lost = 0;
    const flaky = new CrossoverClient({
      baseUrl,
      WebSocket: TrackedWebSocket,
      retry: { attempts: 3, baseMs: 5, maxMs: 10 },
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        if (
          String(input).endsWith("/commands") &&
          String(init?.body).includes('"messages.send"') &&
          lost < 1
        ) {
          lost += 1;
          await res.text();
          throw new TypeError("the response never arrived");
        }
        return res;
      },
    });
    const r = await newRoom(flaky);
    const sent = await r.dev.api.messages.send({ body: "only once" });
    expect(lost).toBe(1);
    expect(sent.replayed).toBe(true); // the retry got the stored answer
    const listed = await r.owner.api.messages.list<{ messages: { body: string }[] }>();
    expect(listed.response.messages.map((m) => m.body)).toEqual(["only once"]);
  });

  it("runs commands over a WebSocket with the same answers as REST", async () => {
    const r = await newRoom();
    const socket = r.dev.socket();
    const sent = await socket.api.messages.send(
      { body: "over the socket" },
      { idempotencyKey: "ws-1" },
    );
    expect(sent.replayed).toBe(false);
    const replay = await socket.api.messages.send(
      { body: "over the socket" },
      { idempotencyKey: "ws-1" },
    );
    expect(replay.replayed).toBe(true);
    await expect(socket.api.events.redact({ sequence: 1, reason: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const read = await socket.api.messages.list<{ messages: { body: string }[] }>();
    expect(read.response.messages.map((m) => m.body)).toEqual(["over the socket"]);
    socket.close();
  });

  it("a stream that is cut over and over loses no event and repeats none, even with events arriving the whole time", async () => {
    const r = await newRoom();
    const received: number[] = [];
    const sub = r.owner.subscribe({
      after: 0,
      reconnect: { minMs: 20, maxMs: 60 },
      onEvent: (e) => received.push(e.sequence),
    });
    // Events keep arriving while the connection is cut three times.
    let cuts = 0;
    const writer = (async () => {
      for (let i = 0; i < 30; i++) {
        await r.owner.api.messages.send({ body: `m${i}` }); // a human: agents have a message budget
        if (i % 8 === 4 && cuts < 3) {
          cuts += 1;
          sockets.at(-1)?.close(); // the network drops
        }
      }
    })();
    await writer;
    const target = await lastSequence(r.owner);
    for (let i = 0; i < 200 && sub.lastSequence < target; i++)
      await new Promise((res) => setTimeout(res, 50));
    sub.close();
    expect(cuts).toBe(3);
    expect(received).toEqual(Array.from({ length: target }, (_, i) => i + 1)); // 1..target, once each, in order
    expect(sockets.length).toBeGreaterThanOrEqual(4); // it really did reconnect
  }, 60_000);

  it("a stream can start from where a client left off, and ends with the error when its token stops working", async () => {
    const r = await newRoom();
    await r.dev.api.messages.send({ body: "a" });
    await r.dev.api.messages.send({ body: "b" });
    const upTo = await lastSequence(r.owner);
    const resumed: number[] = [];
    const sub = r.owner.subscribe({ after: upTo - 1, onEvent: (e) => resumed.push(e.sequence) });
    for (let i = 0; i < 100 && resumed.length < 1; i++)
      await new Promise((res) => setTimeout(res, 50));
    sub.close();
    expect(resumed).toEqual([upTo]);

    const bad = r.client.room(r.roomId, "not-a-token").subscribe({});
    await expect(
      (async () => {
        for await (const e of bad) void e;
      })(),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});

/** Token renewal (T1106): an expired access token is renewed with the refresh token, once. */
describe("SDK token refresh against a real server", () => {
  const expireAccessTokens = (roomId: string) =>
    db.pool.query(
      `UPDATE auth_tokens SET expires_at = now() - interval '1 minute'
       WHERE room_id = $1 AND kind = 'ACCESS'
         AND participant_id IN (SELECT id FROM participants WHERE room_id = $1 AND kind = 'AGENT')`,
      [roomId],
    );
  /** A client that counts the refresh requests it makes. */
  const counting = () => {
    const refreshes = { n: 0 };
    const client = new CrossoverClient({
      baseUrl,
      WebSocket: TrackedWebSocket,
      fetch: async (input, init) => {
        if (String(input).endsWith("/v1/auth/refresh")) refreshes.n += 1;
        return fetch(input, init);
      },
    });
    return { client, refreshes };
  };

  it("an expired access token is renewed and the call retried with the same key; many calls at once refresh once; onTokens gets each pair", async () => {
    const { client, refreshes } = counting();
    const r = await newRoom(client);
    const pairs: RoomTokens[] = [];
    const dev = client.room(r.roomId, r.devTokens, { onTokens: (t) => void pairs.push(t) });
    await dev.api.messages.send({ body: "before" });
    await expireAccessTokens(r.roomId);
    const sent = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        dev.api.messages.send({ body: `after-${i}` }, { idempotencyKey: `renew-${i}` }),
      ),
    );
    expect(sent.every((x) => !x.replayed)).toBe(true);
    expect(refreshes.n).toBe(1);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.access_token).not.toBe(r.devTokens.access_token);
    const listed = await r.owner.api.messages.list<{ messages: { body: string }[] }>();
    expect(listed.response.messages.map((m) => m.body).sort()).toEqual([
      "after-0",
      "after-1",
      "after-2",
      "after-3",
      "after-4",
      "before",
    ]);
    // The new pair keeps working, and renews again later from its own refresh token.
    await expireAccessTokens(r.roomId);
    await dev.api.messages.send({ body: "later" });
    expect(pairs).toHaveLength(2);
  });

  it("without a refresh token, or when it can't be spent, the expiry is the caller's UNAUTHENTICATED", async () => {
    const r = await newRoom();
    await expireAccessTokens(r.roomId);
    await expect(r.dev.api.messages.send({ body: "x" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    // A refresh token someone else already spent: refused, and the original error stands.
    const { client } = counting();
    const spent = await newRoom(client);
    await client.room(spent.roomId, spent.devTokens).api.messages.list(); // fresh
    const pair = await fetch(`${baseUrl}/v1/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: spent.devTokens.refresh_token }),
    });
    expect(pair.status).toBe(200);
    await expireAccessTokens(spent.roomId);
    const stale = client.room(spent.roomId, spent.devTokens);
    await expect(stale.api.messages.list()).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("a subscription outlives its access token: after it expires and the connection drops, it renews and carries on without losing or repeating an event", async () => {
    const { client, refreshes } = counting();
    const r = await newRoom(client);
    const pairs: RoomTokens[] = [];
    const dev = client.room(r.roomId, r.devTokens, { onTokens: (t) => void pairs.push(t) });
    const received: number[] = [];
    const sub = dev.subscribe({
      after: 0,
      reconnect: { minMs: 20, maxMs: 60 },
      onEvent: (e) => received.push(e.sequence),
    });
    await r.owner.api.messages.send({ body: "one" });
    for (let i = 0; i < 100 && received.length < 3; i++)
      await new Promise((res) => setTimeout(res, 50));
    const before = received.length;
    expect(before).toBeGreaterThan(0);

    await expireAccessTokens(r.roomId);
    sockets.at(-1)?.close(); // the connection goes with it
    await r.owner.api.messages.send({ body: "two" });
    await r.owner.api.messages.send({ body: "three" });
    const target = await lastSequence(r.owner);
    for (let i = 0; i < 200 && sub.lastSequence < target; i++)
      await new Promise((res) => setTimeout(res, 50));
    sub.close();
    expect(sub.lastSequence).toBe(target);
    expect(received).toEqual(Array.from({ length: target }, (_, i) => i + 1));
    expect(refreshes.n).toBe(1);
    expect(pairs).toHaveLength(1);
  }, 60_000);

  it("a command socket renews the same way when it connects with an expired token", async () => {
    const r = await newRoom();
    const dev = r.client.room(r.roomId, r.devTokens);
    await expireAccessTokens(r.roomId);
    const socket = dev.socket();
    const sent = await socket.api.messages.send({ body: "over a renewed socket" });
    expect(sent.replayed).toBe(false);
    socket.close();
  });
});
