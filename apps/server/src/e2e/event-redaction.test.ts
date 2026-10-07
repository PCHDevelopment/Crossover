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

const sentSeq = async (r: Awaited<ReturnType<typeof newRoom>>, token: string) =>
  (await r.events(token)).find((e) => e.type === "message.sent")!;

describe("events.redact over HTTP", () => {
  it("the owner redacts a pasted secret: the payload is gone from every read, the hash stays, a record is appended", async () => {
    const r = await newRoom();
    await ok(await r.call(r.dev, "messages.send", { body: `my key is ${SECRET}` }));
    const before = await sentSeq(r, r.owner);
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
      expect(record.payload).toMatchObject({ sequence: before.sequence, reason: "pasted key" });
    }
    const stored = await db.pool.query(
      "SELECT payload_hash, redacted FROM events WHERE room_id = $1 AND sequence = $2",
      [r.roomId, before.sequence],
    );
    expect(stored.rows).toEqual([{ payload_hash: before.payload_hash, redacted: true }]);
  });

  it("a redacted message is blank everywhere a reader can fetch it: the list, the mention's inbox item, an idempotent replay, an edit", async () => {
    const r = await newRoom();
    const ownerId = (await db.pool.query("SELECT owner_id FROM rooms WHERE id = $1", [r.roomId]))
      .rows[0].owner_id as string;
    const send = envelope("messages.send", { body: `key ${SECRET}`, mentions: [ownerId] });
    await ok(await post(`/v1/rooms/${r.roomId}/commands`, send, r.dev));
    const sent = await sentSeq(r, r.owner);
    expect(JSON.stringify(await ok(await r.call(r.owner, "inbox.list")))).toContain(SECRET);

    await ok(await r.call(r.owner, "events.redact", { sequence: sent.sequence, reason: "key" }));

    const list = await ok(await r.call(r.dev, "messages.list"));
    expect(list.response.messages).toMatchObject([{ body: "", redacted: true }]);
    expect(JSON.stringify(list)).not.toContain(SECRET);
    const inbox = await ok(await r.call(r.owner, "inbox.list"));
    expect(JSON.stringify(inbox)).not.toContain(SECRET);
    expect(inbox.response.items[0].summary).toBe("[redacted]");
    // The agent never saw its response: it retries with the same key.
    const replay = await post(`/v1/rooms/${r.roomId}/commands`, send, r.dev);
    expect(replay.body).not.toContain(SECRET);
    const edit = await r.call(r.dev, "messages.edit", {
      message_id: list.response.messages[0].id,
      body: "fixed",
    });
    expect(edit.statusCode).toBe(400);
    expect(edit.json().error.details.reason).toBe("redacted");
  });

  it("redacting an edit takes the whole message with it: its send, its edit and the row", async () => {
    const r = await newRoom();
    const first = await ok(await r.call(r.dev, "messages.send", { body: "harmless" }));
    const id = first.response.id as string;
    await ok(await r.call(r.dev, "messages.edit", { message_id: id, body: `oops ${SECRET}` }));
    const edited = (await r.events(r.owner)).find((e) => e.type === "message.edited")!;
    const out = await ok(
      await r.call(r.owner, "events.redact", { sequence: edited.sequence, reason: "oops" }),
    );
    expect(out.response.also_redacted).toHaveLength(1);
    const all = await r.events(r.owner);
    expect(all.filter((e) => e.redacted).map((e) => e.type)).toEqual(
      expect.arrayContaining(["message.sent", "message.edited"]),
    );
    expect(JSON.stringify(all)).not.toContain("harmless");
    expect(JSON.stringify(await ok(await r.call(r.dev, "messages.list")))).not.toContain(SECRET);
  });

  it("a redacted memory revision is blank in get, list and history, and the current entry too", async () => {
    const r = await newRoom();
    await ok(
      await r.call(r.dev, "memory.put", { key: "notes/k", value: "v1", expected_revision: 0 }),
    );
    await ok(
      await r.call(r.dev, "memory.put", {
        key: "notes/k",
        value: `v2 ${SECRET}`,
        expected_revision: 1,
      }),
    );
    const update = (await r.events(r.owner)).filter((e) => e.type === "memory.updated")[1]!;
    await ok(await r.call(r.owner, "events.redact", { sequence: update.sequence, reason: "key" }));
    const got = await ok(await r.call(r.dev, "memory.get", { key: "notes/k" }));
    expect(got.response).toMatchObject({ value: "", redacted: true, revision: 2 });
    const history = await ok(await r.call(r.dev, "memory.history", { key: "notes/k" }));
    expect(history.response.revisions).toMatchObject([
      { revision: 1, value: "v1", redacted: false },
      { revision: 2, value: "", redacted: true },
    ]);
    const listed = await ok(await r.call(r.dev, "memory.list", {}));
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    // The key can still be written to, on top of the redacted revision.
    await ok(
      await r.call(r.dev, "memory.put", { key: "notes/k", value: "v3", expected_revision: 2 }),
    );
  });

  it("only the owner can: a developer is FORBIDDEN and nothing changes", async () => {
    const r = await newRoom();
    await ok(await r.call(r.dev, "messages.send", { body: `key ${SECRET}` }));
    const sent = await sentSeq(r, r.owner);
    const res = await r.call(r.dev, "events.redact", { sequence: sent.sequence, reason: "mine" });
    expect(res.statusCode).toBe(403);
    expect((await r.events(r.owner)).find((e) => e.sequence === sent.sequence)!.redacted).toBe(
      false,
    );
  });

  it("an unknown sequence is 404, a second redaction is 400, the record itself and the platform's own state events can't be redacted", async () => {
    const r = await newRoom();
    await ok(await r.call(r.dev, "messages.send", { body: "hello" }));
    const sent = await sentSeq(r, r.owner);
    expect(
      (await r.call(r.owner, "events.redact", { sequence: 99999, reason: "x" })).statusCode,
    ).toBe(404);
    await ok(await r.call(r.owner, "events.redact", { sequence: sent.sequence, reason: "x" }));
    const again = await r.call(r.owner, "events.redact", { sequence: sent.sequence, reason: "x" });
    expect(again.json().error.details.reason).toBe("already_redacted");
    const devId = (
      await db.pool.query("SELECT id FROM participants WHERE room_id = $1 AND kind = 'AGENT'", [
        r.roomId,
      ])
    ).rows[0].id as string;
    await ok(await r.call(r.owner, "room.set_lead", { participant_id: devId }));
    const all = await r.events(r.owner);
    const record = all.find((e) => e.type === "event.redacted")!;
    const self = await r.call(r.owner, "events.redact", { sequence: record.sequence, reason: "x" });
    expect(self.json().error.details.reason).toBe("redaction_record");
    const state = all.find((e) => e.type === "lead.changed")!;
    const refused = await r.call(r.owner, "events.redact", {
      sequence: state.sequence,
      reason: "x",
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details.reason).toBe("state_event");
  });

  it("the digest and the WebSocket backfill serve the tombstone: a redacted task title is gone from both", async () => {
    const r = await newRoom();
    await ok(
      await r.call(r.owner, "tasks.create", {
        title: `Rotate ${SECRET}`,
        description: "d",
        requirements: ["r"],
      }),
    );
    const created = (await r.events(r.owner)).find((e) => e.type === "task.created")!;
    expect(JSON.stringify(await ok(await r.call(r.dev, "room.digest", {})))).toContain(SECRET);
    await ok(await r.call(r.owner, "events.redact", { sequence: created.sequence, reason: "key" }));
    expect(JSON.stringify(await ok(await r.call(r.dev, "room.digest", {})))).not.toContain(SECRET);

    const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
    const sock = new WebSocket(`${address.replace("http", "ws")}/v1/rooms/${r.roomId}/ws`);
    const frames: string[] = [];
    sock.onmessage = (m) => frames.push(String(m.data));
    await new Promise((resolve, reject) => {
      sock.onopen = resolve;
      sock.onerror = reject;
    });
    sock.send(
      JSON.stringify({
        type: "hello",
        protocol_version: 1,
        client: "e2e",
        client_version: "1",
        token: r.dev,
      }),
    );
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 100 && !done(); i++) await new Promise((res) => setTimeout(res, 50));
      expect(done()).toBe(true);
    };
    await until(() => frames.some((f) => f.includes('"hello_ok"')));
    sock.send(JSON.stringify({ type: "subscribe", after: 0 }));
    await until(() => frames.some((f) => f.includes('"subscribed"')));
    await until(() => frames.some((f) => f.includes("task.created")));
    sock.close();
    expect(frames.join("\n")).not.toContain(SECRET);
  });
});
