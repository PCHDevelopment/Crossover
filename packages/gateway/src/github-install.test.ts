import { createHash, randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITHUB_INSTALL_STATE_TTL_MS,
  GITHUB_PENDING_CONNECTION_TTL_MS,
  RedisGitHubInstallStore,
} from "./github-install.js";

const stores: RedisGitHubInstallStore[] = [];
const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("RedisGitHubInstallStore", () => {
  it("keeps state and pending records under separate prefixes with ten-minute TTLs", async () => {
    const store = new RedisGitHubInstallStore(redisUrl);
    stores.push(store);
    const probe = new Redis(redisUrl);
    probe.on("error", () => {});
    try {
      await Promise.all([store.ready(), probe.ping()]);
      const state = randomBytes(32).toString("base64url");
      const pendingId = randomBytes(32).toString("base64url");
      const pending = {
        room_id: "room_fixture",
        owner_participant_id: "part_fixture",
        installation_id: "41",
        repositories: [{ name: "Example/Repo", id: "9823" }],
        expires_at: new Date(Date.now() + GITHUB_PENDING_CONNECTION_TTL_MS).toISOString(),
      };
      await store.saveState(state, {
        room_id: pending.room_id,
        owner_participant_id: pending.owner_participant_id,
      });
      await store.save(pendingId, pending);

      const stateKey = `github:install:state:${createHash("sha256").update(state).digest("hex")}`;
      const pendingKey = `github:install:pending:${createHash("sha256").update(pendingId).digest("hex")}`;
      const [stateTtl, pendingTtl] = await Promise.all([
        probe.pttl(stateKey),
        probe.pttl(pendingKey),
      ]);
      expect(stateTtl).toBeGreaterThan(0);
      expect(stateTtl).toBeLessThanOrEqual(GITHUB_INSTALL_STATE_TTL_MS);
      expect(pendingTtl).toBeGreaterThan(0);
      expect(pendingTtl).toBeLessThanOrEqual(GITHUB_PENDING_CONNECTION_TTL_MS);
      expect(await probe.exists(stateKey, pendingKey)).toBe(2);

      const stateResults = await Promise.all([
        store.consumeState(state),
        store.consumeState(state),
      ]);
      expect(stateResults.filter(Boolean)).toEqual([
        { room_id: pending.room_id, owner_participant_id: pending.owner_participant_id },
      ]);
      expect(
        await store.peek(pendingId, { room_id: pending.room_id, owner_participant_id: "other" }),
      ).toBeUndefined();
      expect(
        await store.peek(pendingId, {
          room_id: "room_other",
          owner_participant_id: "part_fixture",
        }),
      ).toBeUndefined();
      expect(
        await store.consume(pendingId, {
          room_id: "room_other",
          owner_participant_id: "part_fixture",
        }),
      ).toBeUndefined();
      expect(await probe.exists(pendingKey)).toBe(1);
      const pendingResults = await Promise.all([
        store.consume(pendingId, {
          room_id: pending.room_id,
          owner_participant_id: pending.owner_participant_id,
        }),
        store.consume(pendingId, {
          room_id: pending.room_id,
          owner_participant_id: pending.owner_participant_id,
        }),
      ]);
      expect(pendingResults.filter(Boolean)).toEqual([pending]);
      expect(await probe.exists(pendingKey)).toBe(0);
    } finally {
      probe.disconnect();
    }
  });

  it("returns expired pending records as unavailable", async () => {
    const store = new RedisGitHubInstallStore(redisUrl);
    stores.push(store);
    const probe = new Redis(redisUrl);
    probe.on("error", () => {});
    try {
      await Promise.all([store.ready(), probe.ping()]);
      const pendingId = randomBytes(32).toString("base64url");
      const state = randomBytes(32).toString("base64url");
      await store.saveState(state, {
        room_id: "room_expired",
        owner_participant_id: "part_expired",
      });
      const stateKey = `github:install:state:${createHash("sha256").update(state).digest("hex")}`;
      const pending = {
        room_id: "room_expired",
        owner_participant_id: "part_expired",
        installation_id: "41",
        repositories: [{ name: "Example/Repo", id: "9823" }],
        expires_at: new Date(Date.now() + GITHUB_PENDING_CONNECTION_TTL_MS).toISOString(),
      };
      await store.save(pendingId, pending);
      const key = `github:install:pending:${createHash("sha256").update(pendingId).digest("hex")}`;
      await probe.pexpire(stateKey, 1);
      await probe.pexpire(key, 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        await store.peek(pendingId, {
          room_id: pending.room_id,
          owner_participant_id: pending.owner_participant_id,
        }),
      ).toBeUndefined();
      expect(await store.consumeState(state)).toBeUndefined();
      expect(await store.consumeState("not-a-state")).toBeUndefined();
    } finally {
      probe.disconnect();
    }
  });
});
