import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import {
  CrossoverClient,
  type RoomClient,
  type SdkEvent,
  type WebSocketCtor,
} from "@crossover/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

/** Filtered subscriptions (T704, §17.1) through the real server and the SDK. */

let db: TestDatabase;
let root: string;
let server: CrossoverServer;
let baseUrl: string;
let serial = 0;
let connections = 0;

const CountingWebSocket = class
  extends (globalThis as unknown as { WebSocket: WebSocketCtor }).WebSocket
{
  constructor(url: string) {
    super(url);
    connections += 1;
  }
} as unknown as WebSocketCtor;

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-filter-e2e-"));
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `filter-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
  };
  server = await composeServer(config, { pool: db.pool });
  baseUrl = await server.app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await server?.close();
  await db?.drop();
  await rm(root, { recursive: true, force: true });
});

const manifest = (name: string) => ({
  name,
  operator: { name: "P", contact: "p@example.com" },
  vendor: "Anthropic",
  model: "m",
  client: "sdk-ts",
  client_version: "1",
  description: name,
});

async function newRoom() {
  const client = new CrossoverClient({ baseUrl, WebSocket: CountingWebSocket });
  const session = await client.devLogin({
    subject: `f-${++serial}-${Date.now()}`,
    display_name: "Owner",
  });
  const created = await client.createRoom(session.session_token, {
    slug: `f-${serial}-${Date.now()}`,
    name: "Filters",
    objective: "Be relevant",
  });
  const roomId = created.response.room.id;
  const owner = client.room(
    roomId,
    (await client.roomSession(session.session_token, roomId)).tokens.access_token,
  );
  const agent = async (name: string) => {
    const invite = await owner.api.room.invite<unknown>({ role: "DEVELOPER" });
    const joined = await client.join(roomId, {
      token: (invite.one_time as { token: string }).token,
      manifest: manifest(name),
    });
    return {
      id: (joined as unknown as { participant_id: string }).participant_id,
      room: client.room(roomId, joined.tokens.access_token),
    };
  };
  return { client, roomId, owner, agent };
}

const lastSequence = async (room: RoomClient) => {
  const out = (await room.api.room.events.list<{ events: SdkEvent[] }>({ limit: 500 })).response
    .events;
  return out[out.length - 1]!.sequence;
};

/** Collect a subscription's events until it has caught up with `target` (or the quiet period passes). */
async function collect(sub: { lastSequence: number }, seen: SdkEvent[], target: number) {
  for (let i = 0; i < 100 && sub.lastSequence < target; i++)
    await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 250)); // anything late would show now
  return seen;
}

describe("filtered subscriptions", () => {
  it("relevant (the agents' default) delivers what concerns the agent and not what concerns others; all and a human's default deliver everything; custom follows its types and scopes", async () => {
    const r = await newRoom();
    const a = await r.agent("AgentA");
    const b = await r.agent("AgentB");
    const types = (events: SdkEvent[]) => events.map((e) => e.type);
    const seenA: SdkEvent[] = [];
    const seenB: SdkEvent[] = [];
    const seenOwner: SdkEvent[] = [];
    const seenAll: SdkEvent[] = [];
    const seenCustom: SdkEvent[] = [];
    const after = await lastSequence(r.owner);
    const open = (room: RoomClient, into: SdkEvent[], extra = {}) =>
      room.subscribe({
        after,
        onEvent: (e) => into.push(e),
        reconnect: { minMs: 20, maxMs: 60 },
        ...extra,
      });
    const subs = [
      open(a.room, seenA), // default for an agent: relevant
      open(b.room, seenB),
      open(r.owner, seenOwner), // default for a human: all
      open(b.room, seenAll, { profile: "all" }),
      open(b.room, seenCustom, { types: ["task.*"], scopes: { tasks: "all", mentions: true } }),
    ];
    for (let i = 0; i < 100 && connections < 5; i++)
      await new Promise((res) => setTimeout(res, 20));

    // Things happen: a task is made and given to A, A starts it; Peter mentions B; B is denied something.
    const task = (
      await r.owner.api.tasks.create<{ id: string; version: number }>({
        title: "Session tokens",
        requirements: ["done"],
      })
    ).response;
    const assigned = (
      await r.owner.api.tasks.assign<{ version: number }>({
        task_id: task.id,
        expected_version: task.version,
        participant_id: a.id,
      })
    ).response;
    await a.room.api.tasks.start({ task_id: task.id, expected_version: assigned.version });
    await r.owner.api.messages.send({ body: "B, look at this", mentions: [b.id] });
    await r.owner.api.messages.send({ body: "just chatter" });
    await b.room.api.events.redact({ sequence: 1, reason: "x" }).catch(() => undefined);

    const target = await lastSequence(r.owner);
    for (const [sub, seen] of [
      [subs[0]!, seenA],
      [subs[1]!, seenB],
      [subs[2]!, seenOwner],
      [subs[3]!, seenAll],
      [subs[4]!, seenCustom],
    ] as const) {
      await collect(sub, seen, target);
    }
    for (const sub of subs) sub.close();

    // A: its task assigned and started; nothing about B's mention or denial, no chatter.
    expect(types(seenA)).toEqual(expect.arrayContaining(["task.assigned", "task.started"]));
    expect(types(seenA)).not.toContain("message.sent");
    expect(types(seenA)).not.toContain("capability.denied");
    // B: its mention and its own denial; no task events (they are A's).
    expect(types(seenB)).toContain("message.sent");
    expect(seenB.filter((e) => e.type === "message.sent")).toHaveLength(1);
    expect(types(seenB)).toContain("capability.denied");
    // A new task nobody owns yet is for whoever claims it; the assignment and the work are A's.
    expect(types(seenB).filter((t) => t.startsWith("task."))).toEqual(["task.created"]);
    // The owner (a human) and the `all` agent see the whole stream, in order, once.
    const everything = Array.from({ length: target - after }, (_, i) => after + 1 + i);
    expect(seenOwner.map((e) => e.sequence)).toEqual(everything);
    expect(seenAll.map((e) => e.sequence)).toEqual(everything);
    // Custom: task events (all of them) and mentions, nothing else.
    expect(new Set(types(seenCustom))).toEqual(
      new Set(["task.created", "task.assigned", "task.started", "message.sent"]),
    );
    expect(seenCustom.filter((e) => e.type === "message.sent")).toHaveLength(1);
    // Filtered streams skip sequence numbers; the SDK didn't take that for a gap and reconnect.
    expect(connections).toBe(5);
    // Sequences stay the room's own, in order.
    for (const seen of [seenA, seenB, seenCustom]) {
      expect(seen.map((e) => e.sequence)).toEqual(
        [...seen.map((e) => e.sequence)].sort((x, y) => x - y),
      );
    }
  }, 60_000);

  it("a bad filter is VALIDATION, and a stream resumed with `after` is filtered the same way", async () => {
    const r = await newRoom();
    const a = await r.agent("AgentA");
    const bad = a.room.subscribe({ profile: "relevant", types: ["task.*"] });
    await expect(
      (async () => {
        for await (const e of bad) void e;
      })(),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const unsupported = a.room.subscribe({
      types: ["task.*"],
      scopes: { files: "touched" } as never,
    });
    await expect(
      (async () => {
        for await (const e of unsupported) void e;
      })(),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("a replay from `after` agrees with the live stream, even when the task changed hands since", async () => {
    const r = await newRoom();
    const a = await r.agent("AgentA");
    const b = await r.agent("AgentB");
    const liveA: SdkEvent[] = [];
    const base = await lastSequence(r.owner);
    const live = a.room.subscribe({
      after: base,
      onEvent: (e) => liveA.push(e),
      reconnect: { minMs: 20, maxMs: 60 },
    });
    const task = (
      await r.owner.api.tasks.create<{ id: string; version: number }>({
        title: "Handed over",
        requirements: ["done"],
      })
    ).response;
    const assigned = (
      await r.owner.api.tasks.assign<{ version: number }>({
        task_id: task.id,
        expected_version: task.version,
        participant_id: a.id,
      })
    ).response;
    const updated = (
      await r.owner.api.tasks.update<{ version: number }>({
        task_id: task.id,
        expected_version: assigned.version,
        description: "more words",
      })
    ).response;
    const released = (
      await a.room.api.tasks.release<{ version: number }>({
        task_id: task.id,
        expected_version: updated.version,
      })
    ).response;
    await b.room.api.tasks.claim({ task_id: task.id, expected_version: released.version });
    await r.owner.api.tasks.update({
      task_id: task.id,
      expected_version: released.version + 1,
      description: "B's now",
    });
    const target = await lastSequence(r.owner);
    await collect(live, liveA, target);
    live.close();

    // A comes back later with the sequence it had before all this: nothing is lost, nothing extra.
    const replayed: SdkEvent[] = [];
    const again = a.room.subscribe({ after: base, onEvent: (e) => replayed.push(e) });
    await collect(again, replayed, target);
    again.close();
    expect(replayed.map((e) => e.sequence)).toEqual(liveA.map((e) => e.sequence));
    const types = replayed.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["task.assigned", "task.updated", "task.released"]),
    );
    // B's claim and the update after it are B's: A gets neither, on replay or live.
    expect(types).not.toContain("task.claimed");
    expect(types.filter((t) => t === "task.updated")).toHaveLength(1);
  }, 60_000);

  it("a pathological type pattern doesn't stall the gateway for everyone else", async () => {
    const r = await newRoom();
    const a = await r.agent("AgentA");
    const started = Date.now();
    const sub = a.room.subscribe({ types: [`workspace.changeset.${"*".repeat(60)}x`] });
    await r.owner.api.messages.send({ body: "still served" });
    const listed = await r.owner.api.messages.list<{ messages: { body: string }[] }>();
    sub.close();
    expect(listed.response.messages).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
