import { createHash, randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import { OAUTH_STATE_TTL_MS, RedisOAuthStateStore } from "./oauth.js";

const stores: RedisOAuthStateStore[] = [];
const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("RedisOAuthStateStore", () => {
  it("stores a bounded transaction and consumes it exactly once across callers", async () => {
    const store = new RedisOAuthStateStore(redisUrl);
    stores.push(store);
    const probe = new Redis(redisUrl);
    probe.on("error", () => {});
    try {
      await Promise.all([store.ready(), probe.ping()]);
      const state = randomBytes(32).toString("base64url");
      const value = { provider: "github", verifier: "verifier" };
      await store.save(state, value);
      const key = `oauth:state:${createHash("sha256").update(state).digest("hex")}`;
      const ttl = await probe.pttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(OAUTH_STATE_TTL_MS);
      const consumed = await Promise.all([store.consume(state), store.consume(state)]);
      expect(consumed.filter(Boolean)).toEqual([value]);
    } finally {
      probe.disconnect();
    }
  });
});
