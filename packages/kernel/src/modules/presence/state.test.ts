import { Redis } from "ioredis";
import { newId } from "@crossover/protocol";
import { afterAll, describe, expect, it } from "vitest";
import {
  presenceChannel,
  presenceFor,
  RedisPresenceStore,
  RedisPresenceSubscriber,
  type Presence,
} from "./state.js";

const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const stores: RedisPresenceStore[] = [];
const store = async (options: ConstructorParameters<typeof RedisPresenceStore>[1] = {}) => {
  const s = new RedisPresenceStore(redisUrl, options);
  stores.push(s);
  await s.ready();
  return s;
};
afterAll(async () => {
  for (const s of stores) await s.close();
});

const value = {
  status: "active" as const,
  open_files: ["src/a.ts"],
  cursor: { path: "src/a.ts", line: 3, column: 7 },
};

describe("presence store (§13.4)", () => {
  it("replaces a participant's record, lists a room's records only, and lets them expire", async () => {
    const s = await store({ ttlMs: 300 });
    const room = newId("room");
    const other = newId("room");
    await s.update(room, "p_b", value);
    await s.update(room, "p_a", { ...value, status: "idle" });
    await s.update(room, "p_a", { status: "active", open_files: [], cursor: null });
    await s.update(other, "p_c", value);
    const listed = await s.list(room);
    expect(listed.map((p) => [p.participant_id, p.status, p.cursor])).toEqual([
      ["p_a", "active", null],
      ["p_b", "active", value.cursor],
    ]);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await s.list(room)).toEqual([]);
  });

  it("publishes each update on the room's presence channel", async () => {
    const s = await store();
    const room = newId("room");
    const sub = new Redis(redisUrl);
    try {
      const got = new Promise<Presence>((resolve) =>
        sub.on("message", (_channel, raw: string) => resolve(JSON.parse(raw) as Presence)),
      );
      await sub.subscribe(presenceChannel(room));
      const expires_at = await s.update(room, "p_a", value);
      expect(await got).toEqual({ ...value, participant_id: "p_a", expires_at });
    } finally {
      sub.disconnect();
    }
  });

  it("a subscriber gets each room's updates, drops what isn't a record, and stops when asked", async () => {
    const s = await store();
    const sub = new RedisPresenceSubscriber(redisUrl);
    const room = newId("room");
    const got: Presence[] = [];
    try {
      const stop = await sub.subscribe(room, (record) => got.push(record));
      const raw = new Redis(redisUrl);
      await raw.publish(presenceChannel(room), "not json");
      await raw.publish(presenceChannel(room), JSON.stringify({ participant_id: "p_x" }));
      raw.disconnect();
      await s.update(newId("room"), "p_other_room", value);
      const expires_at = await s.update(room, "p_a", value);
      await expect.poll(() => got.length).toBe(1);
      expect(got[0]).toEqual({ ...value, participant_id: "p_a", expires_at });
      await stop();
      await s.update(room, "p_a", { ...value, status: "idle" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(got).toHaveLength(1);
    } finally {
      await sub.close();
    }
  });

  it("refuses updates past the per-second limit, per participant", async () => {
    const s = await store({ perSecond: 2 });
    const room = newId("room");
    // Start just after a second boundary, so the three updates share a window.
    await new Promise((resolve) => setTimeout(resolve, 1_000 - (Date.now() % 1_000) + 10));
    expect(await s.update(room, "p_a", value)).toBeTypeOf("string");
    expect(await s.update(room, "p_a", value)).toBeTypeOf("string");
    expect(await s.update(room, "p_a", value)).toBeUndefined();
    expect(await s.update(room, "p_b", value)).toBeTypeOf("string");
  });

  it("a viewer sees only the open files they may read, and a cursor only on one of those", async () => {
    const record: Presence = {
      ...value,
      open_files: ["secrets/key.pem", "src/a.ts"],
      cursor: { path: "secrets/key.pem", line: 1, column: 1 },
      participant_id: "p_a",
      expires_at: "2026-10-10T00:00:00.000Z",
    };
    const mayRead = async (path: string) => !path.startsWith("secrets/");
    const seen = await presenceFor(record, mayRead);
    expect(seen).toMatchObject({ status: "active", open_files: ["src/a.ts"], cursor: null });
    expect(JSON.stringify(seen)).not.toContain("secrets");
    const onReadable = await presenceFor(
      { ...record, cursor: { path: "src/a.ts", line: 2, column: 1 } },
      mayRead,
    );
    expect(onReadable.cursor).toEqual({ path: "src/a.ts", line: 2, column: 1 });
  });
});
