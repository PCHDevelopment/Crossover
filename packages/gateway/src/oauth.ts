import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import type { ProviderIdentity } from "@crossover/kernel";

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export type OAuthState = { provider: string; verifier: string; nonce?: string };

export interface OAuthStateStore {
  save(state: string, value: OAuthState): Promise<void>;
  consume(state: string): Promise<OAuthState | undefined>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export type OAuthAuthorizationRequest = {
  state: string;
  challenge: string;
  redirectUri: string;
  nonce?: string;
};

export type OAuthCodeExchange = {
  code: string;
  redirectUri: string;
  verifier: string;
  nonce?: string;
};

export interface OAuthProvider {
  readonly name: string;
  authorizationUrl(request: OAuthAuthorizationRequest): string;
  identity(request: OAuthCodeExchange): Promise<ProviderIdentity>;
}

const stateKey = (state: string) =>
  `oauth:state:${createHash("sha256").update(state).digest("hex")}`;

/** Redis-backed one-use OAuth transactions shared by all gateway replicas. */
export class RedisOAuthStateStore implements OAuthStateStore {
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

  /** Wait for Redis first, since the client intentionally has no offline queue. */
  async ready(timeoutMs = 5_000): Promise<void> {
    if (this.redis.status !== "ready") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.redis.off("ready", onReady);
          reject(new Error(`OAuth Redis not ready after ${timeoutMs} ms`));
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

  async save(state: string, value: OAuthState): Promise<void> {
    const ttlSeconds = OAUTH_STATE_TTL_MS / 1000;
    const result = await this.redis.set(
      stateKey(state),
      JSON.stringify(value),
      "EX",
      ttlSeconds,
      "NX",
    );
    if (result !== "OK") throw new Error("Could not save OAuth transaction");
  }

  async consume(state: string): Promise<OAuthState | undefined> {
    const raw = await this.redis.getdel(stateKey(state));
    if (raw === null) return undefined;
    try {
      const value = JSON.parse(raw) as OAuthState;
      return typeof value.provider === "string" &&
        typeof value.verifier === "string" &&
        (value.nonce === undefined || typeof value.nonce === "string")
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
