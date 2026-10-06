import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import {
  Dispatcher,
  issueTokens,
  registerInviteCommands,
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
import { buildGateway } from "./server.js";

let db: TestDatabase;
let pool: Pool;
let n = 0;
const apps: FastifyInstance[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
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

async function setup(onInternalError?: (e: unknown) => void) {
  const dispatcher = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerRoomCommands(dispatcher);
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
    ...(onInternalError ? { onInternalError } : {}),
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
