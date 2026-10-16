import { createHash, randomBytes } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
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
      const value = { provider: "github", verifier: "verifier", nonce: "nonce" };
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

  it("fails fast when Redis accepts the connection but never answers", async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const store = new RedisOAuthStateStore(`redis://127.0.0.1:${port}`);
    try {
      const started = Date.now();
      await expect(store.save("state", { provider: "github", verifier: "v" })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await store.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("leaves a caller-supplied client open on close", async () => {
    const client = new Redis(redisUrl);
    client.on("error", () => {});
    try {
      await new RedisOAuthStateStore(client).close();
      expect(await client.ping()).toBe("PONG");
    } finally {
      client.disconnect();
    }
  });
});
