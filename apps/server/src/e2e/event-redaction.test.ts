import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import type { EventPublisher } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

/** `events.redact` through the real server: the policy, the HTTP surface and every ledger read. */

let db: TestDatabase;
let root: string;
let server: CrossoverServer;
let serial = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-redact-e2e-"));
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `redact-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
  };
  const publisher: EventPublisher = { publish: async () => undefined };
  server = await composeServer(config, { pool: db.pool, publisher });
});

afterAll(async () => {
  await server?.close();
  await db?.drop();
  await rm(root, { recursive: true, force: true });
});

const envelope = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `redact-e2e-${++serial}`,
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

const SECRET = "AKIAIOSFODNN7EXAMPLE-pasted-by-mistake";

async function newRoom() {
  const login = await ok(
    await post("/v1/auth/dev-login", { subject: `red-${newId("usr")}`, display_name: "Owner" }),
  );
  const created = await ok(
    await post(
      "/v1/commands",
      envelope("room.create", {
        slug: `red-${++serial}`,
        name: "Redact",
        objective: "Keep secrets",
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
  const dev = (
    await ok(
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
    )
  ).tokens.access_token as string;
  const call = (token: string, method: string, params: Record<string, unknown> = {}) =>
    post(`/v1/rooms/${roomId}/commands`, envelope(method, params), token);
  const events = async (token: string) =>
    (await ok(await call(token, "room.events.list", { limit: 500 }))).response.events as {
      sequence: number;
      type: string;
      actor_id: string;
      payload: Record<string, unknown>;
      payload_hash: string;
      redacted: boolean;
    }[];
  return { roomId, owner, dev, call, events };
}

describe("events.redact over HTTP", () => {
  it("the owner redacts a pasted secret: the payload is gone from every read, the hash stays, a record is appended", async () => {
    const r = await newRoom();
    await ok(await r.call(r.dev, "messages.send", { body: `my key is ${SECRET}` }));
    const before = (await r.events(r.owner)).find((e) => e.type === "message.sent")!;
    expect(JSON.stringify(before.payload)).toContain(SECRET);

    const out = await ok(
      await r.call(r.owner, "events.redact", { sequence: before.sequence, reason: "pasted key" }),
    );
    expect(out.response).toMatchObject({
      sequence: before.sequence,
      event_type: "message.sent",
      payload_hash: before.payload_hash,
    });

    for (const token of [r.owner, r.dev]) {
      const all = await r.events(token);
      const after = all.find((e) => e.sequence === before.sequence)!;
      expect(after).toMatchObject({
        type: "message.sent",
        payload: { redacted: true },
        redacted: true,
        payload_hash: before.payload_hash,
      });
      expect(JSON.stringify(all)).not.toContain(SECRET);
      const record = all.find((e) => e.type === "event.redacted")!;
      expect(record.actor_id).not.toBe(r.dev);
      expect(record.payload).toMatchObject({ sequence: before.sequence, reason: "pasted key" });
      const digest = await ok(await r.call(token, "room.digest", {}));
      expect(JSON.stringify(digest)).not.toContain(SECRET);
    }
    const stored = await db.pool.query(
      "SELECT payload_hash, redacted FROM events WHERE room_id = $1 AND sequence = $2",
      [r.roomId, before.sequence],
    );
    expect(stored.rows).toEqual([{ payload_hash: before.payload_hash, redacted: true }]);
  });

  it("only the owner can: a developer is FORBIDDEN and nothing changes", async () => {
    const r = await newRoom();
    await ok(await r.call(r.dev, "messages.send", { body: `key ${SECRET}` }));
    const sent = (await r.events(r.owner)).find((e) => e.type === "message.sent")!;
    const res = await r.call(r.dev, "events.redact", { sequence: sent.sequence, reason: "mine" });
    expect(res.statusCode).toBe(403);
    expect((await r.events(r.owner)).find((e) => e.sequence === sent.sequence)!.redacted).toBe(
      false,
    );
  });

  it("an unknown sequence is 404, a second redaction is 400, and the redaction record itself can't be redacted", async () => {
    const r = await newRoom();
    await ok(await r.call(r.dev, "messages.send", { body: "hello" }));
    const sent = (await r.events(r.owner)).find((e) => e.type === "message.sent")!;
    expect(
      (await r.call(r.owner, "events.redact", { sequence: 99999, reason: "x" })).statusCode,
    ).toBe(404);
    await ok(await r.call(r.owner, "events.redact", { sequence: sent.sequence, reason: "x" }));
    const again = await r.call(r.owner, "events.redact", { sequence: sent.sequence, reason: "x" });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.details.reason).toBe("already_redacted");
    const record = (await r.events(r.owner)).find((e) => e.type === "event.redacted")!;
    const self = await r.call(r.owner, "events.redact", { sequence: record.sequence, reason: "x" });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.details.reason).toBe("redaction_record");
  });
});
