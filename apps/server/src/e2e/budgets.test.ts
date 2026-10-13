import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { RedisBudgetLimiter, type EventPublisher } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

/** Agent budgets (§22.3) through the real server: Redis counters, the HTTP error and the ledger. */

let db: TestDatabase;
let root: string;
let server: CrossoverServer;
let serial = 0;
let limiter: RedisBudgetLimiter;
// A clock held at the start of a window, so a run can't straddle a minute boundary.
const NOW = 4_000_000 * 60_000;

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-budgets-e2e-"));
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `budgets-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
  };
  const publisher: EventPublisher = { publish: async () => undefined };
  limiter = new RedisBudgetLimiter(config.redisUrl, () => NOW);
  await limiter.ready();
  server = await composeServer(config, { pool: db.pool, publisher, budgets: limiter });
});

afterAll(async () => {
  await server?.close();
  await limiter?.close();
  await db?.drop();
  await rm(root, { recursive: true, force: true });
});

const envelope = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `budgets-e2e-${++serial}`,
});
const post = (url: string, payload: unknown, token?: string) =>
  server.app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: JSON.stringify(payload),
  });
async function ok(res: Awaited<ReturnType<typeof post>>, status = 200) {
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

async function newRoom(settings: Record<string, unknown>) {
  const login = await ok(
    await post("/v1/auth/dev-login", { subject: `bud-${newId("usr")}`, display_name: "Owner" }),
  );
  const created = await ok(
    await post(
      "/v1/commands",
      envelope("room.create", {
        slug: `bud-${++serial}`,
        name: "Budgets",
        objective: "Stay in budget",
        settings,
      }),
      login.session_token,
    ),
  );
  const roomId = created.response.room.id as string;
  const owner = (await ok(await post(`/v1/rooms/${roomId}/session`, {}, login.session_token)))
    .tokens.access_token as string;
  const invite = await ok(
    await post(
      `/v1/rooms/${roomId}/commands`,
      envelope("room.invite", { role: "DEVELOPER" }),
      owner,
    ),
  );
  const joined = await ok(
    await post(`/v1/rooms/${roomId}/join`, {
      token: invite.one_time.token,
      manifest: {
        name: "Dev",
        operator: { name: "P", contact: "p@example.com" },
        vendor: "Anthropic",
        model: "m",
        client: "mcp",
        client_version: "1",
        description: "d",
      },
    }),
    201,
  );
  const dev = joined.tokens.access_token as string;
  const devParticipantId = joined.participant_id as string;
  const call = (token: string, method: string, params: Record<string, unknown> = {}) =>
    post(`/v1/rooms/${roomId}/commands`, envelope(method, params), token);
  return { roomId, owner, dev, devParticipantId, call };
}

describe("agent budgets over HTTP", () => {
  it("an agent over its message budget gets 429 with Retry-After, the room sees one budget.exceeded, and the owner is unaffected", async () => {
    const r = await newRoom({ budgets: { messages: 2 } });
    await ok(await r.call(r.dev, "messages.send", { body: "one" }));
    await ok(await r.call(r.dev, "messages.send", { body: "two" }));
    const refused = await r.call(r.dev, "messages.send", { body: "three" });
    expect(refused.statusCode).toBe(429);
    const error = refused.json().error;
    expect(error).toMatchObject({
      code: "BUDGET_EXCEEDED",
      retryable: true,
      details: { budget: "messages", limit: 2, window_seconds: 60 },
    });
    expect(error.details.retry_after).toBe(60);
    expect(refused.headers["retry-after"]).toBe(String(error.details.retry_after));
    expect((await r.call(r.dev, "messages.send", { body: "four" })).statusCode).toBe(429);

    for (let i = 0; i < 4; i++) await ok(await r.call(r.owner, "messages.send", { body: `h${i}` }));
    const events = (await ok(await r.call(r.owner, "room.events.list", { limit: 500 }))).response
      .events as { type: string; payload: Record<string, unknown> }[];
    const exceeded = events.filter((e) => e.type === "budget.exceeded");
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]!.payload).toMatchObject({ budget: "messages", limit: 2 });
    // Reads are still within the command budget.
    await ok(await r.call(r.dev, "messages.list"));
  });

  it("the defaults apply when nobody overrode them: ten messages a minute", async () => {
    const r = await newRoom({});
    for (let i = 0; i < 10; i++) await ok(await r.call(r.dev, "messages.send", { body: `m${i}` }));
    expect((await r.call(r.dev, "messages.send", { body: "eleventh" })).statusCode).toBe(429);
  });

  it("owners can configure room and agent overrides through the registered API", async () => {
    const r = await newRoom({ budgets: { messages: 6 }, keep: "settings" });
    await ok(
      await r.call(r.owner, "budgets.set", {
        budgets: { commands: null, messages: 1 },
      }),
    );
    await ok(
      await r.call(r.owner, "budgets.set", {
        participant_id: r.devParticipantId,
        budgets: { messages: 2 },
      }),
    );
    await ok(await r.call(r.dev, "messages.send", { body: "counted" }));
    expect((await r.call(r.dev, "messages.send", { body: "over the room cap" })).statusCode).toBe(
      429,
    );

    const state = await ok(await r.call(r.owner, "budgets.get"));
    expect(state.response).toMatchObject({
      room_budgets: { commands: null, messages: 1 },
      agents: [
        {
          participant_id: r.devParticipantId,
          budgets: { messages: 2 },
          effective: { commands: null, messages: 1 },
          usage: { messages: 2 },
        },
      ],
    });
    const settings = (
      await db.pool.query<{ settings: Record<string, unknown> }>(
        "SELECT settings FROM rooms WHERE id = $1",
        [r.roomId],
      )
    ).rows[0]!.settings;
    expect(settings).toMatchObject({ keep: "settings", budgets: { commands: null, messages: 1 } });

    const events = (await ok(await r.call(r.owner, "room.events.list", { limit: 500 }))).response
      .events as { type: string; payload: Record<string, unknown> }[];
    expect(events.filter((event) => event.type === "room.budgets_changed")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: {
            participant_id: null,
            old_budgets: { messages: 6 },
            new_budgets: { commands: null, messages: 1 },
          },
        }),
        expect.objectContaining({
          payload: {
            participant_id: r.devParticipantId,
            old_budgets: {},
            new_budgets: { messages: 2 },
          },
        }),
      ]),
    );
  });
});
