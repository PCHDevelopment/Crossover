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

  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 1 });
    this.redis.on("error", () => {});
  }

  async ready(): Promise<void> {
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
    this.redis.disconnect();
  }
}
