import { CrossoverError } from "@crossover/protocol";
import { describe, expect, it } from "vitest";
import { makeApi } from "./api.js";
import { CrossoverClient } from "./client.js";
import { TransportError, type FetchLike } from "./http.js";
import type { WebSocketCtor, WebSocketLike } from "./ws.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const ok = (response: unknown = {}) => json(200, { response, events: [], replayed: false });

function clientWith(fetchImpl: FetchLike, extra: object = {}, attempts = 3) {
  return new CrossoverClient({
    baseUrl: "http://server.test/",
    fetch: fetchImpl,
    retry: { attempts, baseMs: 1, maxMs: 2 },
    ...extra,
  });
}

describe("typed API", () => {
  it("turns the catalog into namespaces, and knows nothing else", async () => {
    const calls: string[] = [];
    const api = makeApi(async (method) => {
      calls.push(method);
      return { response: null, events: [], replayed: false };
    });
    await api.tasks.create({ title: "t" });
    await api.workspace.health.get();
    await api.room.events.list({ after: 0 });
    expect(calls).toEqual(["tasks.create", "workspace.health.get", "room.events.list"]);
    expect((api as unknown as Record<string, unknown>)["nonsense"]).toBeUndefined();
    expect((api.tasks as unknown as Record<string, unknown>)["nonsense"]).toBeUndefined();
  });
});

describe("REST transport", () => {
  it("puts the bearer token and a fresh idempotency key on a mutating command, none on a read", async () => {
    const seen: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    const room = clientWith(async (url, init) => {
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return ok();
    }).room("room_1", "tok");
    await room.api.messages.send({ body: "hi" });
    await room.api.messages.send({ body: "hi" });
    await room.api.messages.list();
    expect(seen[0]).toMatchObject({
      url: "http://server.test/v1/rooms/room_1/commands",
      auth: "Bearer tok",
      body: { method: "messages.send", params: { body: "hi" } },
    });
    const [a, b, read] = seen.map((s) => s.body);
    expect(a!["idempotency_key"]).toBeTypeOf("string");
    expect(a!["idempotency_key"]).not.toBe(b!["idempotency_key"]);
    expect(a!["id"]).not.toBe(b!["id"]);
    expect(read).not.toHaveProperty("idempotency_key");
    // A key of your own is used as given.
    await room.api.messages.send({ body: "x" }, { idempotencyKey: "mine-1" });
    expect(seen[3]!.body["idempotency_key"]).toBe("mine-1");
  });

  it("retries a lost connection, a 429 and a 503 with the very same request, and nothing else", async () => {
    const bodies: string[] = [];
    let n = 0;
    const room = clientWith(
      async (_url, init) => {
        bodies.push(String(init?.body));
        n += 1;
        if (n === 1) throw new TypeError("fetch failed");
        if (n === 2)
          return json(
            429,
            { error: { code: "BUDGET_EXCEEDED", message: "slow", retryable: true } },
            { "retry-after": "0" },
          );
        if (n === 3)
          return json(503, {
            error: { code: "STALE_FENCE", message: "handing over", retryable: true },
          });
        return ok({ done: true });
      },
      {},
      4,
    ).room("room_1", "tok");
    const result = await room.api.messages.send({ body: "once" });
    expect(result.response).toEqual({ done: true });
    expect(bodies).toHaveLength(4);
    expect(new Set(bodies).size).toBe(1); // same id, same idempotency key

    let calls = 0;
    const forbidden = clientWith(async () => {
      calls += 1;
      return json(403, {
        error: {
          code: "FORBIDDEN",
          message: "no",
          retryable: false,
          details: { missing_capability: "x" },
        },
      });
    }).room("room_1", "tok");
    const err = await forbidden.api.messages.send({ body: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossoverError);
    expect(err).toMatchObject({
      code: "FORBIDDEN",
      retryable: false,
      details: { missing_capability: "x" },
    });
    expect(calls).toBe(1);
  });

  it("gives up after the attempts it was told, as a retryable TransportError; a 202 gate is an error with its details", async () => {
    const down = clientWith(async () => {
      throw new TypeError("fetch failed");
    }).room("room_1", "tok");
    const err = await down.api.messages.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).retryable).toBe(true);

    const gated = clientWith(async () =>
      json(202, {
        error: {
          code: "APPROVAL_REQUIRED",
          message: "wait",
          retryable: false,
          details: { approval_id: "appr_1" },
        },
      }),
    ).room("room_1", "tok");
    await expect(gated.api.messages.send({ body: "x" })).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
      details: { approval_id: "appr_1" },
    });
  });

  it("signs in, creates a room, exchanges a session and joins, against the documented routes", async () => {
    const urls: string[] = [];
    const client = clientWith(async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/v1/auth/dev-login"))
        return json(200, {
          user: { id: "u", display_name: "O" },
          session_token: "us_1",
          expires_at: "x",
        });
      if (String(url).endsWith("/v1/commands")) return ok({ room: { id: "room_9" } });
      if (String(url).endsWith("/session")) return json(200, { tokens: { access_token: "rt_1" } });
      return json(201, { tokens: { access_token: "rt_2" } });
    });
    const session = await client.devLogin({ subject: "s", display_name: "O" });
    const created = await client.createRoom(session.session_token, {
      slug: "a",
      name: "A",
      objective: "o",
    });
    const access = await client.roomSession(session.session_token, created.response.room.id);
    const joined = await client.join("room_9", { token: "inv", manifest: {} });
    expect([access.tokens.access_token, joined.tokens.access_token]).toEqual(["rt_1", "rt_2"]);
    expect(urls).toEqual([
      "http://server.test/v1/auth/dev-login",
      "http://server.test/v1/commands",
      "http://server.test/v1/rooms/room_9/session",
      "http://server.test/v1/rooms/room_9/join",
    ]);
  });
});

/** A WebSocket the test drives: it plays the server's side of each connection. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  static script: ((socket: FakeSocket, index: number) => void) | undefined;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  index: number;
  constructor(readonly url: string) {
    this.index = FakeSocket.instances.length;
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string) {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame["type"] === "hello") {
      this.emit({
        type: "hello_ok",
        protocol_version: 1,
        participant_id: "part_1",
        room_id: "room_1",
      });
    } else if (frame["type"] === "subscribe") {
      this.emit({ type: "subscribed", after: frame["after"], last_sequence: 99 });
      FakeSocket.script?.(this, this.index);
    }
  }
  emit(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  event(sequence: number) {
    this.emit({
      type: "event",
      event: { room_id: "room_1", sequence, type: "message.sent", payload: {} },
    });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  close(code = 1000) {
    this.drop(code);
  }
}

const subscribeWith = (script: (s: FakeSocket, i: number) => void, options: object = {}) => {
  FakeSocket.instances = [];
  FakeSocket.script = script;
  const room = clientWith(async () => ok(), {
    WebSocket: FakeSocket as unknown as WebSocketCtor,
  }).room("room_1", "tok");
  return room.subscribe({ reconnect: { minMs: 1, maxMs: 2 }, ...options });
};

const take = async (sub: AsyncIterable<{ sequence: number }>, n: number) => {
  const got: number[] = [];
  for await (const e of sub) {
    got.push(e.sequence);
    if (got.length === n) break;
  }
  return got;
};

describe("subscribe", () => {
  it("delivers every event once and in order across a dropped connection, asking for what's after the last one", async () => {
    const sub = subscribeWith((s, i) => {
      if (i === 0) {
        s.event(1);
        s.event(2);
        s.event(3);
        s.drop(); // the network went away
      } else if (i === 1) {
        s.event(3); // the server may repeat what was in flight
        s.event(4);
        s.event(5);
      }
    });
    expect(await take(sub, 5)).toEqual([1, 2, 3, 4, 5]);
    sub.close();
    expect(FakeSocket.instances[1]!.sent.find((f) => f["type"] === "subscribe")).toMatchObject({
      after: 3,
    });
    expect(sub.lastSequence).toBe(5);
  });

  it("reconnects after resync_required, and after a gap instead of skipping it", async () => {
    const sub = subscribeWith((s, i) => {
      if (i === 0) {
        s.event(1);
        s.emit({ type: "resync_required" });
        s.drop(4409);
      } else if (i === 1) {
        s.event(2);
        s.event(5); // 3 and 4 never came
      } else if (i === 2) {
        s.event(3);
        s.event(4);
        s.event(5);
      }
    });
    expect(await take(sub, 5)).toEqual([1, 2, 3, 4, 5]);
    sub.close();
    const afters = FakeSocket.instances.map(
      (i) => i.sent.find((f) => f["type"] === "subscribe")?.["after"],
    );
    expect(afters).toEqual([0, 1, 2]);
  });

  it("starts after the sequence you give, and tells you through callbacks too", async () => {
    const seen: number[] = [];
    const states: string[] = [];
    const sub = subscribeWith(
      (s) => {
        s.event(11);
        s.event(12);
      },
      {
        after: 10,
        onEvent: (e: { sequence: number }) => seen.push(e.sequence),
        onState: (s: string) => states.push(s),
      },
    );
    await take(sub, 2);
    sub.close();
    expect(FakeSocket.instances[0]!.sent.find((f) => f["type"] === "subscribe")).toMatchObject({
      after: 10,
    });
    expect(seen).toEqual([11, 12]);
    expect(states).toEqual(["connecting", "live", "closed"]);
  });

  it("ends with the error when it can't continue: an invalid token isn't retried", async () => {
    FakeSocket.instances = [];
    FakeSocket.script = undefined;
    class Rejecting extends FakeSocket {
      override send(data: string) {
        const frame = JSON.parse(data) as Record<string, unknown>;
        if (frame["type"] === "hello") {
          this.emit({
            type: "error",
            error: { code: "UNAUTHENTICATED", message: "bad token", retryable: false },
          });
          this.drop(4401);
        }
      }
    }
    const room = clientWith(async () => ok(), {
      WebSocket: Rejecting as unknown as WebSocketCtor,
    }).room("room_1", "bad");
    const errors: unknown[] = [];
    const sub = room.subscribe({
      reconnect: { minMs: 1, maxMs: 2 },
      onError: (e) => errors.push(e),
    });
    await expect(take(sub, 1)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(errors).toHaveLength(1);
    expect(FakeSocket.instances).toHaveLength(1); // no retry storm
  });

  it("close() ends the stream and the connection", async () => {
    const sub = subscribeWith((s) => s.event(1));
    expect(await take(sub, 1)).toEqual([1]);
    sub.close();
    const rest: number[] = [];
    for await (const e of sub) rest.push(e.sequence);
    expect(rest).toEqual([]);
    expect(FakeSocket.instances[0]!.readyState).toBe(3);
  });
});
