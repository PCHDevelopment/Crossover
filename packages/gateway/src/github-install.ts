import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import type { GitHubPendingConnection, GitHubPendingConnectionStore } from "@crossover/kernel";

export const GITHUB_INSTALL_STATE_TTL_MS = 10 * 60_000;
export const GITHUB_PENDING_CONNECTION_TTL_MS = 10 * 60_000;

export interface GitHubInstallState {
  room_id: string;
  owner_participant_id: string;
}

export interface GitHubInstallStateStore {
  saveState(state: string, value: GitHubInstallState): Promise<void>;
  consumeState(state: string): Promise<GitHubInstallState | undefined>;
}

const hashKey = (prefix: string, value: string) =>
  `${prefix}:${createHash("sha256").update(value).digest("hex")}`;
const stateKey = (state: string) => hashKey("github:install:state", state);
const pendingKey = (pendingId: string) => hashKey("github:install:pending", pendingId);

function parseState(raw: string | null): GitHubInstallState | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as GitHubInstallState).room_id === "string" &&
      (value as GitHubInstallState).room_id.length > 0 &&
      typeof (value as GitHubInstallState).owner_participant_id === "string" &&
      (value as GitHubInstallState).owner_participant_id.length > 0
    ) {
      return {
        room_id: (value as GitHubInstallState).room_id,
        owner_participant_id: (value as GitHubInstallState).owner_participant_id,
      };
    }
  } catch {
    // Malformed entries are discarded by the consuming GETDEL.
  }
  return undefined;
}

function parsePending(raw: string | null): GitHubPendingConnection | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const pending = value as GitHubPendingConnection;
    if (
      typeof pending.room_id !== "string" ||
      !pending.room_id ||
      typeof pending.owner_participant_id !== "string" ||
      !pending.owner_participant_id ||
      typeof pending.installation_id !== "string" ||
      !/^[1-9]\d{0,15}$/.test(pending.installation_id) ||
      typeof pending.expires_at !== "string" ||
      !Number.isFinite(Date.parse(pending.expires_at)) ||
      !Array.isArray(pending.repositories) ||
      pending.repositories.length === 0 ||
      pending.repositories.some(
        (repository) =>
          !repository ||
          typeof repository !== "object" ||
          typeof repository.name !== "string" ||
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.name) ||
          typeof repository.id !== "string" ||
          !/^[1-9]\d{0,19}$/.test(repository.id),
      )
    ) {
      return undefined;
    }
    return {
      room_id: pending.room_id,
      owner_participant_id: pending.owner_participant_id,
      installation_id: pending.installation_id,
      repositories: pending.repositories.map(({ name, id }) => ({ name, id })),
      expires_at: pending.expires_at,
    };
  } catch {
    return undefined;
  }
}

/** Redis state and pending records for GitHub App installation handshakes. */
export class RedisGitHubInstallStore
  implements GitHubInstallStateStore, GitHubPendingConnectionStore
{
  private readonly redis: Redis;
  private readonly ownsClient: boolean;

  constructor(source: string | Redis) {
    if (typeof source === "string") {
      this.redis = new Redis(source, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1_000,
        commandTimeout: 500,
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
      } as never);
      this.redis.on("error", () => {});
      this.ownsClient = true;
    } else {
      this.redis = source;
      this.ownsClient = false;
    }
  }

  async ready(timeoutMs = 5_000): Promise<void> {
    if (this.redis.status !== "ready") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.redis.off("ready", onReady);
          reject(new Error(`GitHub install Redis not ready after ${timeoutMs} ms`));
        }, timeoutMs);
        const onReady = () => {
          clearTimeout(timer);
          resolve();
        };
        this.redis.once("ready", onReady);
      });
    }
    await this.redis.ping();
  }

  async saveState(state: string, value: GitHubInstallState): Promise<void> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error("Invalid GitHub install state");
    if (!value.room_id || !value.owner_participant_id)
      throw new Error("Invalid GitHub install binding");
    const result = await this.redis.set(
      stateKey(state),
      JSON.stringify(value),
      "EX",
      GITHUB_INSTALL_STATE_TTL_MS / 1000,
      "NX",
    );
    if (result !== "OK") throw new Error("Could not save GitHub install state");
  }

  async consumeState(state: string): Promise<GitHubInstallState | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return undefined;
    return parseState(await this.redis.getdel(stateKey(state)));
  }

  async save(pendingId: string, value: GitHubPendingConnection): Promise<void> {
    const parsed = parsePending(JSON.stringify(value));
    if (!/^[A-Za-z0-9_-]{43}$/.test(pendingId) || !parsed)
      throw new Error("Invalid GitHub pending connection");
    const result = await this.redis.set(
      pendingKey(pendingId),
      JSON.stringify(parsed),
      "EX",
      GITHUB_PENDING_CONNECTION_TTL_MS / 1000,
      "NX",
    );
    if (result !== "OK") throw new Error("Could not save GitHub pending connection");
  }

  async peek(
    pendingId: string,
    binding: { room_id: string; owner_participant_id: string },
  ): Promise<GitHubPendingConnection | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(pendingId)) return undefined;
    const pending = parsePending(await this.redis.get(pendingKey(pendingId)));
    if (
      !pending ||
      Date.parse(pending.expires_at) <= Date.now() ||
      pending.room_id !== binding.room_id ||
      pending.owner_participant_id !== binding.owner_participant_id
    ) {
      return undefined;
    }
    return pending;
  }

  async consume(
    pendingId: string,
    binding: { room_id: string; owner_participant_id: string },
  ): Promise<GitHubPendingConnection | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(pendingId)) return undefined;
    const raw = await this.redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return false end
       local ok, value = pcall(cjson.decode, raw)
       if not ok or type(value) ~= 'table' or value.room_id ~= ARGV[1]
          or value.owner_participant_id ~= ARGV[2] then return false end
       redis.call('DEL', KEYS[1])
       return raw`,
      1,
      pendingKey(pendingId),
      binding.room_id,
      binding.owner_participant_id,
    );
    const pending = parsePending(typeof raw === "string" ? raw : null);
    if (!pending || Date.parse(pending.expires_at) <= Date.now()) return undefined;
    return pending;
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
