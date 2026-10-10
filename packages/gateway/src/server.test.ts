import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import {
  Dispatcher,
  issueTokens,
  registerInviteCommands,
  registerRoomEventsCommand,
  registerJoinCommand,
  registerRoomCommands,
  type TokenPair,
} from "@crossover/kernel";
import { authorize } from "@crossover/policy";
import { CrossoverError, ERROR_CODES, newId } from "@crossover/protocol";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HTTP_STATUS, toHttpError } from "./errors.js";
import { buildGateway, clientKey } from "./server.js";

let db: TestDatabase;
let pool: Pool;
let n = 0;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  // Participants reference users (T216), so the fixed ids the tests use must exist.
  await pool.query(
    `INSERT INTO users (id, display_name, provider, provider_subject)
     SELECT 'user_' || g, 'Peter', 'test', 'user_' || g FROM generate_series(1, 3000) g`,
  );
});

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await db.drop();
});

let keyN = 0;
const envelope = (method: string, params: Record<string, unknown> = {}, key?: string) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: key ?? `k-${++keyN}`,
});

const manifest = (extra: Record<string, unknown> = {}) => ({
  name: "Claude-1",
  operator: { name: "Peter", contact: "peter@example.com" },
  vendor: "Anthropic",
  model: "claude-opus-5",
  client: "mcp",
  client_version: "1.0.0",
  description: "Writes TypeScript",
  ...extra,
});

async function setup(
  onInternalError?: (e: unknown) => void,
  devLogin = false,
  gateway: Partial<Parameters<typeof buildGateway>[0]> = {},
) {
  const dispatcher = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerRoomCommands(dispatcher);
  registerRoomEventsCommand(dispatcher);
  registerInviteCommands(dispatcher);
  registerJoinCommand(dispatcher);
  dispatcher.registerCommand({
    method: "tasks.claim",
    action: "tasks.create",
    mutating: true,
    params: z.object({}),
    execute: async () => {
      throw new CrossoverError("APPROVAL_REQUIRED", "Queued", { details: { approval_id: "ap_1" } });
    },
  });
  dispatcher.registerCommand({
    method: "tasks.assign",
    action: "tasks.create",
    mutating: true,
    params: z.object({}),
    execute: async () => {
      throw new Error("secret internal detail: password=hunter2");
    },
  });
  const app = buildGateway({
    dispatcher,
    pool,
    devLogin,
    ...(onInternalError ? { onInternalError } : {}),
    ...gateway,
  });
  apps.push(app);

  const out = await dispatcher.dispatchRoomless(
    { user_id: `user_${++n}`, display_name: "Peter" },
    {
      id: newId("cmd"),
      method: "room.create",
      params: { slug: `gw-${++n}-${Date.now().toString(36)}`, name: "n", objective: "o" },
      idempotency_key: `k-${++keyN}`,
    },
  );
  const { room, participant } = out.response as {
    room: { id: string };
    participant: { id: string };
  };
  const owner = await issueTokens(pool, participant.id);
  return { app, dispatcher, room: room.id, owner };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const post = (s: Setup, path: string, body: unknown, headers: Record<string, string> = {}) =>
  s.app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json", ...headers },
    payload: typeof body === "string" ? body : JSON.stringify(body),
  });

const command = (s: Setup, body: unknown, token: string = s.owner.access_token) =>
  post(s, `/v1/rooms/${s.room}/commands`, body, { authorization: `Bearer ${token}` });

async function invite(s: Setup, role = "DEVELOPER"): Promise<string> {
  const res = await command(s, envelope("room.invite", { role }));
  expect(res.statusCode).toBe(200);
  return res.json().one_time.token as string;
}

const errorShape = (body: unknown, code: string, status: number, res: { statusCode: number }) => {
  expect(res.statusCode).toBe(status);
  expect(body).toMatchObject({ error: { code, retryable: expect.any(Boolean) } });
  expect(Object.keys((body as { error: object }).error).sort()).toEqual(
    expect.arrayContaining(["code", "message", "retryable"]),
  );
  expect(Object.keys(body as object)).toEqual(["error"]);
};

describe("POST /v1/rooms/:roomId/commands", () => {
  it("runs a command and returns response, events and replayed, uncached", async () => {
    const s = await setup();
    const res = await command(s, envelope("room.invite", { role: "REVIEWER" }));
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.response).toMatchObject({ role: "REVIEWER" });
    expect(body.events.map((e: { type: string }) => e.type)).toEqual(["participant.invited"]);
    expect(body.replayed).toBe(false);
    expect(body.one_time.token).toMatch(/^inv_/);
  });

  it("replays an idempotent retry without the one-time secret", async () => {
    const s = await setup();
    const env = envelope("room.invite", { role: "DEVELOPER" }, "same-key");
    const first = await command(s, env);
    const second = await command(s, env);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().one_time).toBeUndefined();
    expect(second.json().response.invite_id).toBe(first.json().response.invite_id);
  });

  it.each([
    ["no header", {}],
    ["wrong scheme", { authorization: "Basic abc" }],
    ["empty bearer", { authorization: "Bearer " }],
    ["unknown token", { authorization: "Bearer at_nope" }],
    ["a refresh token", { authorization: "Bearer rt_nope" }],
  ])("%s → 401 UNAUTHENTICATED with the §16.3 body", async (_n, headers) => {
    const s = await setup();
    const res = await post(s, `/v1/rooms/${s.room}/commands`, envelope("room.invite"), headers);
    errorShape(res.json(), "UNAUTHENTICATED", 401, res);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });

  it("a token for another room looks like a missing room (404)", async () => {
    const a = await setup();
    const b = await setup();
    const res = await post(a, `/v1/rooms/${b.room}/commands`, envelope("room.invite"), {
      authorization: `Bearer ${a.owner.access_token}`,
    });
    errorShape(res.json(), "NOT_FOUND", 404, res);
    // …and it did nothing in either room.
    const { rows } = await pool.query("SELECT 1 FROM invites WHERE room_id = ANY($1)", [
      [a.room, b.room],
    ]);
    expect(rows).toHaveLength(0);
    const nonexistent = await post(a, `/v1/rooms/room_nope/commands`, envelope("room.invite"), {
      authorization: `Bearer ${a.owner.access_token}`,
    });
    expect(nonexistent.json()).toEqual(res.json());
  });

  it("maps FORBIDDEN to 403 and keeps the details", async () => {
    const s = await setup();
    const joined = await post(s, `/v1/rooms/${s.room}/join`, {
      token: await invite(s),
      manifest: manifest(),
    });
    const agent = (joined.json().tokens as TokenPair).access_token;
    const res = await command(s, envelope("room.invite", { role: "DEVELOPER" }), agent);
    errorShape(res.json(), "FORBIDDEN", 403, res);
  });

  it("maps validation failures to 400 and unknown methods to 404", async () => {
    const s = await setup();
    const bad = await command(s, envelope("room.invite", { role: "LEAD" }));
    errorShape(bad.json(), "VALIDATION", 400, bad);
    const noKey = await command(s, { id: newId("cmd"), method: "room.invite", params: {} });
    errorShape(noKey.json(), "VALIDATION", 400, noKey);
    const unknown = await command(s, envelope("nothing.here"));
    errorShape(unknown.json(), "NOT_FOUND", 404, unknown);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an array", "[]"],
    ["a string", '"x"'],
    ["null", "null"],
  ])("a body that is %s → 400 VALIDATION", async (_n, body) => {
    const s = await setup();
    const res = await command(s, body);
    errorShape(res.json(), "VALIDATION", 400, res);
  });

  it("a non-JSON content type → 400 VALIDATION", async () => {
    const s = await setup();
    const res = await s.app.inject({
      method: "POST",
      url: `/v1/rooms/${s.room}/commands`,
      headers: { "content-type": "text/plain", authorization: `Bearer ${s.owner.access_token}` },
      payload: "hello",
    });
    errorShape(res.json(), "VALIDATION", 400, res);
  });

  it("rejects an oversized body as a validation error", async () => {
    const s = await setup();
    const res = await command(s, envelope("room.invite", { pad: "x".repeat(2 * 1024 * 1024) }));
    errorShape(res.json(), "VALIDATION", 400, res);
  });

  it("answers APPROVAL_REQUIRED with 202 and the approval details", async () => {
    const s = await setup();
    const res = await command(s, envelope("tasks.claim"));
    errorShape(res.json(), "APPROVAL_REQUIRED", 202, res);
    expect(res.json().error.details).toEqual({ approval_id: "ap_1" });
  });

  it("hides the cause of an internal error and reports it to the hook", async () => {
    const seen = vi.fn();
    const s = await setup(seen);
    const res = await command(s, envelope("tasks.assign"));
    expect(res.statusCode).toBe(500);
    expect(res.payload).not.toContain("hunter2");
    expect(res.json().error).toMatchObject({ message: "Internal error", retryable: false });
    expect(seen).toHaveBeenCalledOnce();
  });

  it("unknown routes get the error body too", async () => {
    const s = await setup();
    const res = await s.app.inject({ method: "GET", url: "/nope" });
    errorShape(res.json(), "NOT_FOUND", 404, res);
  });
});

describe("POST /v1/rooms/:roomId/join", () => {
  it("creates the agent and returns working tokens, uncached", async () => {
    const s = await setup();
    const token = await invite(s, "REVIEWER");
    const res = await post(s, `/v1/rooms/${s.room}/join`, { token, manifest: manifest() });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toMatchObject({ room_id: s.room, role: "REVIEWER", display_name: "Claude-1" });
    // The new credentials work for the new participant.
    const state = await command(s, envelope("room.get_state"), body.tokens.access_token);
    expect(state.statusCode).toBe(200);
  });

  it("a reused invite token → 401, and a wrong-room path is refused without spending it", async () => {
    const s = await setup();
    const other = await setup();
    const token = await invite(s);
    const wrong = await post(s, `/v1/rooms/${other.room}/join`, { token, manifest: manifest() });
    errorShape(wrong.json(), "UNAUTHENTICATED", 401, wrong);
    const ok = await post(s, `/v1/rooms/${s.room}/join`, { token, manifest: manifest() });
    expect(ok.statusCode).toBe(201);
    const again = await post(s, `/v1/rooms/${s.room}/join`, { token, manifest: manifest() });
    errorShape(again.json(), "UNAUTHENTICATED", 401, again);
  });

  it("an invalid manifest → 400 and the token still works", async () => {
    const s = await setup();
    const token = await invite(s);
    const bad = await post(s, `/v1/rooms/${s.room}/join`, {
      token,
      manifest: manifest({ wake_webhook_url: "http://insecure.example" }),
    });
    errorShape(bad.json(), "VALIDATION", 400, bad);
    const ok = await post(s, `/v1/rooms/${s.room}/join`, { token, manifest: manifest() });
    expect(ok.statusCode).toBe(201);
  });

  it("needs no bearer header, and ignores one", async () => {
    const s = await setup();
    const token = await invite(s);
    const res = await post(
      s,
      `/v1/rooms/${s.room}/join`,
      { token, manifest: manifest() },
      { authorization: "Bearer garbage" },
    );
    expect(res.statusCode).toBe(201);
  });
});

describe("error mapping", () => {
  it("maps every error code to the spec's status", () => {
    expect(HTTP_STATUS).toMatchObject({
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      UNAVAILABLE: 503,
      PROVIDER_UNAVAILABLE: 503,
      VALIDATION: 400,
      CONFLICT_VERSION: 409,
      CONFLICT_MERGE: 409,
      RATE_LIMITED: 429,
      BUDGET_EXCEEDED: 429,
      APPROVAL_REQUIRED: 202,
    });
    for (const code of ERROR_CODES) {
      const mapped = toHttpError(new CrossoverError(code, "m", { details: { a: 1 } }));
      expect(mapped.status).toBe(HTTP_STATUS[code]);
      if (code !== "STALE_FENCE") expect(mapped.body.error).toMatchObject({ code, message: "m" });
    }
  });

  it("STALE_FENCE becomes a retryable 503 that doesn't leak its details", () => {
    const mapped = toHttpError(
      new CrossoverError("STALE_FENCE", "fence 7 < 9", { details: { fencing_token: 7 } }),
    );
    expect(mapped.status).toBe(503);
    expect(JSON.stringify(mapped.body)).not.toContain("fence 7");
    expect(mapped.body.error.retryable).toBe(true);
  });

  it("keeps retry-after details for throttling", () => {
    const mapped = toHttpError(
      new CrossoverError("RATE_LIMITED", "slow down", { details: { retry_after: 30 } }),
    );
    expect(mapped).toMatchObject({
      status: 429,
      body: { error: { retryable: true, details: { retry_after: 30 } } },
    });
  });
});

describe("platform users (T216)", () => {
  const login = (s: Setup, subject: string, display_name = "Peter") =>
    post(s, "/v1/auth/dev-login", { subject, display_name });
  const subject = () => `dev-${++n}-${Date.now().toString(36)}`;

  it("dev login doesn't exist unless explicitly enabled", async () => {
    const s = await setup();
    const sub = subject();
    const res = await login(s, sub);
    errorShape(res.json(), "NOT_FOUND", 404, res);
    const { rows } = await pool.query("SELECT 1 FROM users WHERE provider_subject = $1", [sub]);
    expect(rows).toHaveLength(0);
  });

  it("signs a user in with a session token, and the same subject is the same user", async () => {
    const s = await setup(undefined, true);
    const sub = subject();
    const a = await login(s, sub, "Peter");
    expect(a.statusCode).toBe(200);
    expect(a.headers["cache-control"]).toBe("no-store");
    expect(a.json().session_token).toMatch(/^us_/);
    const b = await login(s, sub, "Someone else");
    expect(b.json().user.id).toBe(a.json().user.id);
    expect(b.json().user.display_name).toBe("Peter"); // not renamed
    expect(b.json().session_token).not.toBe(a.json().session_token);
    const { rows } = await pool.query("SELECT provider FROM users WHERE provider_subject = $1", [
      sub,
    ]);
    expect(rows).toEqual([{ provider: "dev" }]);
  });

  it.each([
    ["missing subject", { display_name: "P" }],
    ["empty name", { subject: "x", display_name: " " }],
    ["unknown field", { subject: "x", display_name: "P", provider: "github" }],
    ["not an object", [1]],
  ])("rejects a malformed login (%s)", async (_n, body) => {
    const s = await setup(undefined, true);
    const res = await post(s, "/v1/auth/dev-login", body);
    errorShape(res.json(), "VALIDATION", 400, res);
  });

  it("creates a room through the gateway and records the user as the owner's user_id", async () => {
    const s = await setup(undefined, true);
    const session = (await login(s, subject())).json();
    const res = await post(
      s,
      "/v1/commands",
      envelope("room.create", {
        slug: `gwr-${++n}-${Date.now().toString(36)}`,
        name: "n",
        objective: "o",
      }),
      { authorization: `Bearer ${session.session_token}` },
    );
    expect(res.statusCode).toBe(200);
    const { participant } = res.json().response as { participant: { id: string } };
    const { rows } = await pool.query(
      "SELECT user_id, authority, kind FROM participants WHERE id = $1",
      [participant.id],
    );
    expect(rows[0]).toEqual({ user_id: session.user.id, authority: "OWNER", kind: "HUMAN" });
  });

  it("only accepts a user session on the roomless route, and only a room token on room routes", async () => {
    const s = await setup(undefined, true);
    const session = (await login(s, subject())).json();
    const roomRoute = await command(s, envelope("room.get_state"), session.session_token);
    errorShape(roomRoute.json(), "UNAUTHENTICATED", 401, roomRoute);
    const rootRoute = await post(s, "/v1/commands", envelope("room.create", {}), {
      authorization: `Bearer ${s.owner.access_token}`,
    });
    errorShape(rootRoute.json(), "UNAUTHENTICATED", 401, rootRoute);
    const none = await post(s, "/v1/commands", envelope("room.create", {}));
    errorShape(none.json(), "UNAUTHENTICATED", 401, none);
  });

  it("a room-bound method on the roomless route is NOT_FOUND", async () => {
    const s = await setup(undefined, true);
    const session = (await login(s, subject())).json();
    const res = await post(s, "/v1/commands", envelope("room.get_state"), {
      authorization: `Bearer ${session.session_token}`,
    });
    errorShape(res.json(), "NOT_FOUND", 404, res);
  });
});

describe("POST /v1/rooms/:roomId/session (T217)", () => {
  const login = (s: Setup, subject: string) =>
    post(s, "/v1/auth/dev-login", { subject, display_name: "Peter" });
  const sub = () => `sess-${++n}-${Date.now().toString(36)}`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function createRoom(s: Setup, sessionToken: string): Promise<string> {
    const res = await post(
      s,
      "/v1/commands",
      envelope("room.create", {
        slug: `sr-${++n}-${Date.now().toString(36)}`,
        name: "n",
        objective: "o",
      }),
      bearer(sessionToken),
    );
    expect(res.statusCode).toBe(200);
    return (res.json().response as { room: { id: string } }).room.id;
  }
  const exchange = (s: Setup, roomId: string, token: string) =>
    post(s, `/v1/rooms/${roomId}/session`, {}, bearer(token));

  it("gives the room's creator working owner tokens: login, create a room, exchange, invite", async () => {
    const s = await setup(undefined, true);
    const session = (await login(s, sub())).json().session_token as string;
    const roomId = await createRoom(s, session);
    const res = await exchange(s, roomId, session);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toMatchObject({ room_id: roomId, role: "LEAD", authority: "OWNER" });
    const invited = await post(
      s,
      `/v1/rooms/${roomId}/commands`,
      envelope("room.invite", { role: "DEVELOPER" }),
      bearer(body.tokens.access_token),
    );
    expect(invited.statusCode).toBe(200);
  });

  it("each exchange starts its own token family, and both stay valid", async () => {
    const s = await setup(undefined, true);
    const session = (await login(s, sub())).json().session_token as string;
    const roomId = await createRoom(s, session);
    const a = (await exchange(s, roomId, session)).json().tokens;
    const b = (await exchange(s, roomId, session)).json().tokens;
    expect(a.family_id).not.toBe(b.family_id);
    for (const t of [a, b]) {
      const state = await post(
        s,
        `/v1/rooms/${roomId}/commands`,
        envelope("room.get_state"),
        bearer(t.access_token),
      );
      expect(state.statusCode).toBe(200);
    }
  });

  it("looks the same for a room that doesn't exist and one the user isn't in", async () => {
    const s = await setup(undefined, true);
    const mine = (await login(s, sub())).json().session_token as string;
    const theirs = (await login(s, sub())).json().session_token as string;
    const theirRoom = await createRoom(s, theirs);
    const notMember = await exchange(s, theirRoom, mine);
    const missing = await exchange(s, "room_does_not_exist", mine);
    errorShape(notMember.json(), "NOT_FOUND", 404, notMember);
    expect(notMember.json()).toEqual(missing.json());
    expect(notMember.statusCode).toBe(missing.statusCode);
  });

  it("refuses removed and invited members (403) but serves paused ones", async () => {
    const s = await setup(undefined, true);
    const session = (await login(s, sub())).json().session_token as string;
    const roomId = await createRoom(s, session);
    const setStatus = (status: string) =>
      pool.query("UPDATE participants SET status = $2 WHERE room_id = $1 AND kind = 'HUMAN'", [
        roomId,
        status,
      ]);
    for (const status of ["REMOVED", "INVITED"]) {
      await setStatus(status);
      const res = await exchange(s, roomId, session);
      errorShape(res.json(), "FORBIDDEN", 403, res);
    }
    await setStatus("PAUSED");
    const paused = await exchange(s, roomId, session);
    expect(paused.statusCode).toBe(200);
    const cmd = await post(
      s,
      `/v1/rooms/${roomId}/commands`,
      envelope("room.get_state"),
      bearer(paused.json().tokens.access_token),
    );
    errorShape(cmd.json(), "PARTICIPANT_PAUSED", 403, cmd);
  });

  it("only a user session works: no header, a room token or an unknown session is 401", async () => {
    const s = await setup(undefined, true);
    const session = (await login(s, sub())).json().session_token as string;
    const roomId = await createRoom(s, session);
    for (const headers of [{}, bearer(s.owner.access_token), bearer("us_" + "x".repeat(43))]) {
      const res = await post(s, `/v1/rooms/${roomId}/session`, {}, headers);
      errorShape(res.json(), "UNAUTHENTICATED", 401, res);
    }
  });
});

describe("GET /v1/rooms/:roomId/events and /state (T702)", () => {
  const get = (s: Setup, path: string, token: string | null = s.owner.access_token) =>
    s.app.inject({
      method: "GET",
      url: path,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  /** A room with a handful of events: creation, a join, and some invites. */
  async function busy() {
    const s = await setup(undefined, true);
    const session = (
      await post(s, "/v1/auth/dev-login", { subject: `ev-${++n}-${Date.now()}`, display_name: "P" })
    ).json().session_token as string;
    const created = await post(
      s,
      "/v1/commands",
      envelope("room.create", {
        slug: `ev-${++n}-${Date.now().toString(36)}`,
        name: "n",
        objective: "o",
      }),
      { authorization: `Bearer ${session}` },
    );
    const roomId = (created.json().response as { room: { id: string } }).room.id;
    const tokens = (
      await post(s, `/v1/rooms/${roomId}/session`, {}, { authorization: `Bearer ${session}` })
    ).json().tokens;
    const room = { ...s, room: roomId, owner: tokens as typeof s.owner };
    for (let i = 0; i < 4; i++) {
      await command(room, envelope("room.invite", { role: "DEVELOPER" }));
    }
    return room;
  }

  it("lists a room's events in order, uncached, to any member", async () => {
    const s = await busy();
    const res = await get(s, `/v1/rooms/${s.room}/events`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as {
      events: { sequence: number; type: string }[];
      next_after: number | null;
    };
    expect(body.events.map((e) => e.sequence)).toEqual(body.events.map((_, i) => i + 1));
    expect(body.events.map((e) => e.type)).toEqual([
      "room.created",
      "participant.joined",
      "participant.invited",
      "participant.invited",
      "participant.invited",
      "participant.invited",
    ]);
    expect(body.next_after).toBeNull(); // caught up
  });

  it("pages with after and limit: next_after continues, null when caught up", async () => {
    const s = await busy();
    const first = (await get(s, `/v1/rooms/${s.room}/events?limit=4`)).json();
    expect(first.events).toHaveLength(4);
    expect(first.next_after).toBe(4);
    const second = (await get(s, `/v1/rooms/${s.room}/events?after=4&limit=4`)).json();
    expect(second.events.map((e: { sequence: number }) => e.sequence)).toEqual([5, 6]);
    expect(second.next_after).toBeNull();
    expect((await get(s, `/v1/rooms/${s.room}/events?after=6`)).json().events).toEqual([]);
  });

  it("filters by types: exact names, wildcards and several at once", async () => {
    const s = await busy();
    const types = async (q: string) =>
      (
        (await get(s, `/v1/rooms/${s.room}/events?types=${q}`)).json().events as { type: string }[]
      ).map((e) => e.type);
    expect(await types("participant.invited")).toEqual(Array(4).fill("participant.invited"));
    expect((await types("participant.*")).length).toBe(5);
    expect(await types("room.created,participant.joined")).toEqual([
      "room.created",
      "participant.joined",
    ]);
  });

  it.each([
    ["after=-1"],
    ["after=abc"],
    ["limit=0"],
    ["limit=501"],
    ["limit=1.5"],
    ["types=not.an.event"],
    ["types=nothing.*"],
    ["types="],
  ])("rejects bad query %s with 400 VALIDATION", async (q) => {
    const s = await busy();
    const res = await get(s, `/v1/rooms/${s.room}/events?${q}`);
    errorShape(res.json(), "VALIDATION", 400, res);
  });

  it("returns the room state, summary by default and full on request", async () => {
    const s = await busy();
    const summary = await get(s, `/v1/rooms/${s.room}/state`);
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toMatchObject({ view: "summary", last_sequence: 6 });
    expect(summary.json().sections.room).toMatchObject({ id: s.room });
    const full = await get(s, `/v1/rooms/${s.room}/state?view=full`);
    expect(full.json()).toMatchObject({ view: "full" });
    errorShape((await get(s, `/v1/rooms/${s.room}/state?view=nope`)).json(), "VALIDATION", 400, {
      statusCode: 400,
    });
  });

  it("room ID in the path must match the token's room (404, and no data), and a token is needed (401)", async () => {
    const a = await busy();
    const b = await busy();
    for (const path of ["events", "state"]) {
      const wrong = await get(a, `/v1/rooms/${b.room}/${path}`);
      errorShape(wrong.json(), "NOT_FOUND", 404, wrong);
      expect(JSON.stringify(wrong.json())).not.toContain("participant");
      const missing = await get(a, `/v1/rooms/${a.room}/${path}`, null);
      errorShape(missing.json(), "UNAUTHENTICATED", 401, missing);
      const bad = await get(a, `/v1/rooms/${a.room}/${path}`, "at_nope");
      errorShape(bad.json(), "UNAUTHENTICATED", 401, bad);
    }
    const nonexistent = await get(a, "/v1/rooms/room_nope/events");
    expect(nonexistent.json()).toEqual((await get(a, `/v1/rooms/${b.room}/events`)).json());
  });

  it("only shows events of the caller's own room, even for a paused or removed member's token", async () => {
    const a = await busy();
    const b = await busy();
    const events = (await get(a, `/v1/rooms/${a.room}/events`)).json().events as {
      room_id: string;
    }[];
    expect(new Set(events.map((e) => e.room_id))).toEqual(new Set([a.room]));
    expect(b.room).not.toBe(a.room);
    await pool.query(
      "UPDATE participants SET status = 'REMOVED' WHERE room_id = $1 AND authority = 'OWNER'",
      [a.room],
    );
    const res = await get(a, `/v1/rooms/${a.room}/events`);
    errorShape(res.json(), "UNAUTHENTICATED", 401, res);
  });
});

describe("POST /v1/auth/refresh", () => {
  it("spends a refresh token for a new pair that works, and the shape matches the join's tokens", async () => {
    const s = await setup();
    const res = await post(s, "/v1/auth/refresh", { refresh_token: s.owner.refresh_token });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const pair = res.json() as TokenPair;
    expect(Object.keys(pair).sort()).toEqual([
      "access_expires_at",
      "access_token",
      "family_id",
      "refresh_expires_at",
      "refresh_token",
    ]);
    expect(pair.access_token).not.toBe(s.owner.access_token);
    const read = await command(
      s,
      { id: newId("cmd"), method: "room.get_state", params: {} },
      pair.access_token,
    );
    expect(read.statusCode).toBe(200);
  });

  it("a spent refresh token is refused and takes its family with it; junk is UNAUTHENTICATED; a bad body is VALIDATION", async () => {
    const s = await setup();
    const first = await post(s, "/v1/auth/refresh", { refresh_token: s.owner.refresh_token });
    const pair = first.json() as TokenPair;
    // Past the grace window for a lost response, a spent token is a replay.
    await pool.query(
      "UPDATE auth_tokens SET used_at = used_at - interval '31 seconds', created_at = created_at - interval '31 seconds'",
    );
    const again = await post(s, "/v1/auth/refresh", { refresh_token: s.owner.refresh_token });
    errorShape(again.json(), "UNAUTHENTICATED", 401, again);
    // The family is revoked: even the newest pair no longer works.
    const dead = await post(s, "/v1/auth/refresh", { refresh_token: pair.refresh_token });
    errorShape(dead.json(), "UNAUTHENTICATED", 401, dead);
    const junk = await post(s, "/v1/auth/refresh", { refresh_token: "rt_nonsense" });
    errorShape(junk.json(), "UNAUTHENTICATED", 401, junk);
    const access = await post(s, "/v1/auth/refresh", { refresh_token: s.owner.access_token });
    errorShape(access.json(), "UNAUTHENTICATED", 401, access);
    const bad = await post(s, "/v1/auth/refresh", { nope: 1 });
    errorShape(bad.json(), "VALIDATION", 400, bad);
  });
});

describe("POST /v1/auth/refresh rate limit", () => {
  /** Fixed-window counter per key, in memory. */
  const counter = () => {
    const counts = new Map<string, number>();
    return {
      hit: async (key: string, limit: number) => {
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return next <= limit
          ? { allowed: true as const }
          : { allowed: false as const, retry_after_ms: 12_500 };
      },
    };
  };
  const junk = { refresh_token: "rt_nonsense" };

  it("refuses attempts over the limit per client address with RATE_LIMITED and Retry-After, junk or not", async () => {
    const s = await setup(undefined, false, { refreshLimit: { limiter: counter(), perMinute: 3 } });
    for (let i = 0; i < 3; i++) {
      const res = await post(s, "/v1/auth/refresh", junk);
      expect(res.statusCode).toBe(401);
    }
    const limited = await post(s, "/v1/auth/refresh", { refresh_token: s.owner.refresh_token });
    errorShape(limited.json(), "RATE_LIMITED", 429, limited);
    expect(limited.headers["retry-after"]).toBe("13");
    // Only this route is limited.
    const read = await command(s, { id: newId("cmd"), method: "room.get_state", params: {} });
    expect(read.statusCode).toBe(200);
  });

  it("is per address: X-Forwarded-For counts only behind a trusted proxy", async () => {
    const via = (ip: string) => ({ "x-forwarded-for": ip });
    const trusted = await setup(undefined, false, {
      trustProxy: ["127.0.0.1"],
      refreshLimit: { limiter: counter(), perMinute: 1 },
    });
    expect((await post(trusted, "/v1/auth/refresh", junk, via("203.0.113.1"))).statusCode).toBe(
      401,
    );
    expect((await post(trusted, "/v1/auth/refresh", junk, via("203.0.113.1"))).statusCode).toBe(
      429,
    );
    expect((await post(trusted, "/v1/auth/refresh", junk, via("203.0.113.2"))).statusCode).toBe(
      401,
    );
    // Behind one trusted hop, what the client wrote on the left is not its address: the entry the
    // proxy added is. Each forged value must not buy a fresh allowance.
    const forged = await setup(undefined, false, {
      trustProxy: ["127.0.0.1"],
      refreshLimit: { limiter: counter(), perMinute: 1 },
    });
    expect(
      (await post(forged, "/v1/auth/refresh", junk, via("1.1.1.1, 203.0.113.9"))).statusCode,
    ).toBe(401);
    expect(
      (await post(forged, "/v1/auth/refresh", junk, via("2.2.2.2, 203.0.113.9"))).statusCode,
    ).toBe(429);
    const direct = await setup(undefined, false, {
      refreshLimit: { limiter: counter(), perMinute: 1 },
    });
    expect((await post(direct, "/v1/auth/refresh", junk, via("203.0.113.1"))).statusCode).toBe(401);
    // A spoofed header doesn't get a fresh allowance.
    expect((await post(direct, "/v1/auth/refresh", junk, via("203.0.113.9"))).statusCode).toBe(429);
  });

  it("limits an IPv6 client by its /64 and an IPv4-mapped address as IPv4", () => {
    expect(clientKey("2001:db8:abcd:12:1:2:3:4")).toBe(clientKey("2001:db8:abcd:12:ffff::9"));
    expect(clientKey("2001:db8:abcd:12::1")).toBe("2001:db8:abcd:12::/64");
    expect(clientKey("2001:db8:abcd:13::1")).not.toBe(clientKey("2001:db8:abcd:12::1"));
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(clientKey("203.0.113.5")).toBe("203.0.113.5");
  });

  it("a limiter that fails doesn't take refreshing down", async () => {
    const broken = { hit: async () => Promise.reject(new Error("redis is down")) };
    const s = await setup(undefined, false, { refreshLimit: { limiter: broken, perMinute: 1 } });
    const res = await post(s, "/v1/auth/refresh", { refresh_token: s.owner.refresh_token });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /v1/rooms and the static web app (T1104)", () => {
  it("lists the caller's own rooms, and nothing without a user session", async () => {
    const s = await setup(undefined, true);
    const login = await post(s, "/v1/auth/dev-login", {
      subject: `lister-${n}`,
      display_name: "L",
    });
    const session = (login.json() as { session_token: string }).session_token;
    const bearer = { authorization: `Bearer ${session}` };
    const empty = await s.app.inject({ method: "GET", url: "/v1/rooms", headers: bearer });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ rooms: [] });
    const created = await post(
      s,
      "/v1/commands",
      {
        id: newId("cmd"),
        method: "room.create",
        params: { slug: `listed-${n}`, name: "Listed", objective: "Show up" },
        idempotency_key: `k-${n}`,
      },
      bearer,
    );
    expect(created.statusCode, created.body).toBe(200);
    const mine = await s.app.inject({ method: "GET", url: "/v1/rooms", headers: bearer });
    expect(mine.json().rooms).toMatchObject([
      { name: "Listed", slug: `listed-${n}`, status: "ACTIVE", role: "LEAD", authority: "OWNER" },
    ]);
    expect(mine.headers["cache-control"]).toBe("no-store");
    // Someone else's session doesn't see it; a room token isn't a user session.
    const other = await post(s, "/v1/auth/dev-login", { subject: `other-${n}`, display_name: "O" });
    const theirs = await s.app.inject({
      method: "GET",
      url: "/v1/rooms",
      headers: {
        authorization: `Bearer ${(other.json() as { session_token: string }).session_token}`,
      },
    });
    expect(theirs.json()).toEqual({ rooms: [] });
    for (const headers of [{}, { authorization: `Bearer ${s.owner.access_token}` }]) {
      const res = await s.app.inject({ method: "GET", url: "/v1/rooms", headers });
      expect(res.statusCode).toBe(401);
    }
  });

  it("serves the built app from staticRoot: files, the app's routes as index.html, never outside the root or under /v1", async () => {
    // The file "outside the root" sits next to it inside a private temp directory, not in the shared
    // tmpdir, where a fixed name can collide with another user's file.
    const parent = await mkdtemp(join(tmpdir(), "static-"));
    const root = join(parent, "root");
    await mkdir(join(root, "assets"), { recursive: true });
    await writeFile(join(root, "index.html"), "<!doctype html><title>app</title>");
    await writeFile(join(root, "assets", "app-abc.js"), "console.log(1)");
    await writeFile(join(root, "secret.txt"), "not served");
    const outside = join(parent, "outside.js");
    await writeFile(outside, "outside");
    const s = await setup(undefined, false, { staticRoot: root });
    const get = (url: string) => s.app.inject({ method: "GET", url });
    const index = await get("/");
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.headers["content-security-policy"]).toContain("default-src 'self'");
    expect((await get("/rooms/rom_x")).body).toContain("<title>app</title>");
    const asset = await get("/assets/app-abc.js");
    expect(asset.body).toBe("console.log(1)");
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect((await get("/secret.txt")).statusCode).toBe(404); // not a type the app has
    for (const url of [
      "/..%2foutside.js",
      "/assets/..%2f..%2foutside.js",
      "/%2e%2e/%2e%2e/etc/passwd.js",
      "/v1/nothing",
      "/v1/rooms/x/unknown",
    ]) {
      expect((await get(url)).statusCode, url).toBe(404);
    }
    const post404 = await s.app.inject({ method: "POST", url: "/anything", payload: {} });
    expect(post404.statusCode).toBe(404);
    // Without staticRoot nothing is served.
    const bare = await setup();
    expect((await bare.app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
  });
});
