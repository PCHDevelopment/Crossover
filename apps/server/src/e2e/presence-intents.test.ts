import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { RedisEditIntentStore as RedisIntentStore, type EventPublisher } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
let db: TestDatabase;
let root: string;
let server: CrossoverServer;
let serial = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-presence-e2e-"));
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl,
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `presence-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
  };
  const publisher: EventPublisher = { publish: async (_room, _events) => undefined };
  server = await composeServer(config, { pool: db.pool, publisher });
});

afterAll(async () => {
  await server?.close();
  await db?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

const envelope = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `presence-e2e-${++serial}`,
});

async function post(url: string, payload: unknown, token?: string) {
  return server.app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: JSON.stringify(payload),
  });
}

async function ok(response: Awaited<ReturnType<typeof post>>, status = 200) {
  expect(response.statusCode, response.body).toBe(status);
  return response.json();
}

async function makeRoom() {
  const login = await ok(
    await post("/v1/auth/dev-login", {
      subject: `presence-${newId("usr")}`,
      display_name: "Presence test owner",
    }),
  );
  const created = await ok(
    await post(
      "/v1/commands",
      envelope("room.create", {
        slug: `presence-${++serial}`,
        name: "Presence test",
        objective: "Test edit intents",
      }),
      login.session_token,
    ),
  );
  const roomId = created.response.room.id as string;
  const owner = await ok(await post(`/v1/rooms/${roomId}/session`, {}, login.session_token));
  const token = owner.tokens.access_token as string;
  const cmd = (method: string, params: Record<string, unknown> = {}, actorToken = token) =>
    post(`/v1/rooms/${roomId}/commands`, envelope(method, params), actorToken);
  return { roomId, token, cmd };
}

async function inviteAgent(room: Awaited<ReturnType<typeof makeRoom>>, role = "DEVELOPER") {
  const invite = await ok(await room.cmd("room.invite", { role }));
  const joined = await ok(
    await post(`/v1/rooms/${room.roomId}/join`, {
      token: invite.one_time.token,
      manifest: {
        name: "Presence agent",
        operator: { name: "Test", contact: "test@example.com" },
        vendor: "test",
        model: "test",
        client: "mcp",
        client_version: "1",
        description: "T606 test participant",
      },
    }),
    201,
  );
  return joined.tokens.access_token as string;
}

describe("edit intents over the server API", () => {
  it("normalizes and replaces intents, validates ranges/tasks, and isolates rooms", async () => {
    const a = await makeRoom();
    const agentToken = await inviteAgent(a);
    const observerToken = await inviteAgent(a, "OBSERVER");
    const b = await makeRoom();
    const task = await ok(
      await a.cmd("tasks.create", { title: "Edit auth", requirements: ["Auth is secure"] }),
    );
    const beforeEvents = await db.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM events WHERE room_id = $1",
      [a.roomId],
    );

    const set = await ok(
      await a.cmd("presence.set_intent", {
        paths: ["src//auth.ts", "src/auth.ts"],
        ranges: [{ path: "src/auth.ts", start_line: 40, end_line: 62 }],
        task_id: task.response.id,
      }),
    );
    expect(new Date(set.response.expires_at).getTime()).toBeGreaterThan(Date.now());
    const initial = await ok(await a.cmd("presence.list_intents"));
    expect(initial.response.intents).toHaveLength(1);
    expect(initial.response.intents[0]).toMatchObject({
      participant_id: task.response.created_by,
      paths: ["src/auth.ts"],
      ranges: [{ path: "src/auth.ts", start_line: 40, end_line: 62 }],
      task_id: task.response.id,
    });
    const replaced = await ok(await a.cmd("presence.set_intent", { paths: ["src/new.ts"] }));
    expect(new Date(replaced.response.expires_at).getTime()).toBeGreaterThan(
      new Date(set.response.expires_at).getTime(),
    );
    await ok(await a.cmd("presence.set_intent", { paths: ["src/new.ts"] }, agentToken));
    await ok(await a.cmd("presence.set_intent", { paths: ["docs/observer.md"] }, observerToken));
    await ok(await b.cmd("presence.set_intent", { paths: ["docs/other.md"] }));

    const listedA = await ok(await a.cmd("presence.list_intents"));
    expect(listedA.response.intents).toHaveLength(3);
    expect(listedA.response.intents).toEqual(
      [...listedA.response.intents].sort((x, y) =>
        x.participant_id < y.participant_id ? -1 : x.participant_id > y.participant_id ? 1 : 0,
      ),
    );
    const ownerIntent = listedA.response.intents.find(
      (intent: { participant_id: string }) => intent.participant_id === task.response.created_by,
    );
    const agentIntent = listedA.response.intents.find(
      (intent: { participant_id: string }) => intent.participant_id !== task.response.created_by,
    );
    const observerIntent = listedA.response.intents.find(
      (intent: { participant_id: string; paths: string[] }) =>
        intent.participant_id !== task.response.created_by &&
        intent.paths[0] === "docs/observer.md",
    );
    expect(ownerIntent).toMatchObject({
      paths: ["src/new.ts"],
      ranges: [],
      task_id: null,
    });
    expect(ownerIntent).not.toHaveProperty("display_name");
    expect((await ok(await b.cmd("presence.list_intents"))).response.intents).toHaveLength(1);

    const rangePathNotListed = await a.cmd("presence.set_intent", {
      paths: ["src/auth.ts"],
      ranges: [{ path: "src/other.ts", start_line: 1, end_line: 2 }],
    });
    expect(rangePathNotListed.statusCode).toBe(400);
    const reversedRange = await a.cmd("presence.set_intent", {
      paths: ["src/auth.ts"],
      ranges: [{ path: "src/auth.ts", start_line: 2, end_line: 1 }],
    });
    expect(reversedRange.statusCode).toBe(400);
    const invalidPath = await a.cmd("presence.set_intent", { paths: ["../secret"] });
    expect(invalidPath.statusCode).toBe(400);
    const crossRoomTask = await b.cmd("presence.set_intent", {
      paths: ["docs/readme.md"],
      task_id: task.response.id,
    });
    expect(crossRoomTask.statusCode).toBe(404);

    await ok(await a.cmd("presence.clear_intent"));
    await ok(await a.cmd("presence.clear_intent")); // idempotent when already absent
    const afterClear = await ok(await a.cmd("presence.list_intents"));
    expect(afterClear.response.intents).toEqual(
      [agentIntent, observerIntent].sort((x, y) =>
        x.participant_id < y.participant_id ? -1 : x.participant_id > y.participant_id ? 1 : 0,
      ),
    );
    const eventsAfterIntents = await db.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM events WHERE room_id = $1",
      [a.roomId],
    );
    expect(eventsAfterIntents.rows[0]?.count).toBe(beforeEvents.rows[0]?.count);
  });

  it("expires a Redis intent without a heartbeat", async () => {
    const store = new RedisIntentStore(redisUrl, { ttlMs: 150 });
    const roomId = newId("room");
    const participantId = newId("part");
    try {
      await store.ready();
      await store.set(roomId, participantId, {
        paths: ["src/short-lived.ts"],
        ranges: [],
        task_id: null,
      });
      expect(await store.list(roomId)).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 220));
      expect(await store.list(roomId)).toEqual([]);
    } finally {
      await store.clear(roomId, participantId);
      await store.close();
    }
  });
});

describe("presence over the server API (§13.4)", () => {
  it("updates replace the caller's record, observers may update, nothing reaches the ledger, and updates are validated and rate-limited", async () => {
    const a = await makeRoom();
    const observerToken = await inviteAgent(a, "OBSERVER");
    const before = await db.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM events WHERE room_id = $1",
      [a.roomId],
    );
    const cursor = {
      path: "src/auth.ts",
      line: 4,
      column: 2,
      selection: { start_line: 4, start_column: 2, end_line: 6, end_column: 1 },
    };
    const set = await ok(
      await a.cmd("presence.update", { open_files: ["src//auth.ts", "docs/a.md"], cursor }),
    );
    expect(new Date(set.response.expires_at).getTime()).toBeGreaterThan(Date.now());
    await ok(await a.cmd("presence.update", { status: "idle" }, observerToken));
    const listed = (await ok(await a.cmd("presence.list"))).response.presence;
    expect(listed).toHaveLength(2);
    expect(listed).toContainEqual(
      expect.objectContaining({
        status: "active",
        open_files: ["src/auth.ts", "docs/a.md"],
        cursor,
      }),
    );
    expect(listed).toContainEqual(
      expect.objectContaining({ status: "idle", open_files: [], cursor: null }),
    );

    for (const params of [
      { open_files: ["docs/a.md"], cursor: { path: "src/auth.ts", line: 1, column: 1 } },
      {
        open_files: ["src/auth.ts"],
        cursor: {
          ...cursor,
          selection: { start_line: 6, start_column: 1, end_line: 4, end_column: 1 },
        },
      },
      { open_files: ["../secret"] },
      { status: "away" },
    ]) {
      const refused = await a.cmd("presence.update", params);
      expect(refused.statusCode, JSON.stringify(params)).toBe(400);
    }

    // 45 updates span at most two one-second windows of 20.
    const codes = [];
    for (let i = 0; i < 45; i++) {
      const res = await a.cmd("presence.update", { open_files: ["src/auth.ts"] });
      codes.push(res.statusCode);
      if (res.statusCode !== 200) {
        expect(res.json().error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
        break;
      }
    }
    expect(codes.at(-1)).toBe(429);

    const after = await db.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM events WHERE room_id = $1",
      [a.roomId],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});
