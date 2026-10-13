import { Redis } from "ioredis";
import { newId } from "@crossover/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { editIntentChannel, RedisEditIntentStore } from "./intents.js";

const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";
const stores: RedisEditIntentStore[] = [];
const store = async () => {
  const value = new RedisEditIntentStore(redisUrl, { ttlMs: 30_000 });
  stores.push(value);
  await value.ready();
  return value;
};

afterAll(async () => {
  for (const value of stores) await value.close();
});

describe("edit intent store", () => {
  it("refreshes an identical intent TTL without broadcasting a redundant invalidation", async () => {
    const intents = await store();
    const roomId = newId("room");
    const subscriber = new Redis(redisUrl);
    const messages: string[] = [];
    try {
      subscriber.on("message", (_channel, message: string) => messages.push(message));
      await subscriber.subscribe(editIntentChannel(roomId));
      const value = {
        paths: ["src/a.ts"],
        ranges: [{ path: "src/a.ts", start_line: 2, end_line: 4 }],
        task_id: "task_a",
      };

      const firstExpiry = await intents.set(roomId, "agent_a", value);
      await expect.poll(() => messages.length).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const refreshedExpiry = await intents.set(roomId, "agent_a", value);
      expect(Date.parse(refreshedExpiry)).toBeGreaterThan(Date.parse(firstExpiry));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(messages).toEqual(["changed"]);

      await intents.set(roomId, "agent_a", { ...value, paths: ["src/b.ts"] });
      await expect.poll(() => messages.length).toBe(2);
      expect(messages).toEqual(["changed", "changed"]);
    } finally {
      subscriber.disconnect();
    }
  });
});
