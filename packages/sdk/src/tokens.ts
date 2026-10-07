import { CrossoverError } from "@crossover/protocol";
import { postJson, type FetchLike, type RetryOptions } from "./http.js";

/** A participant's access to one room: what `join` and `roomSession` return as `tokens`. */
export interface RoomTokens {
  access_token: string;
  /** Present for a participant who can renew the access token (`POST /v1/auth/refresh`). */
  refresh_token?: string;
  [key: string]: unknown;
}

export interface TokenOptions {
  /**
   * Called with every new token pair after a refresh, **before the request that needed it is
   * retried**. Refresh tokens are single-use: persist the pair here (a file, a secret store), or
   * the next process to start will present a spent token. If it throws, the call that triggered
   * the refresh fails with that error.
   */
  onTokens?: (tokens: RoomTokens) => void | Promise<void>;
}

/**
 * The tokens one room client works with, and how they renew. When the server answers
 * `UNAUTHENTICATED` (the access token expired) and a refresh token is held, **one** refresh runs
 * however many calls and subscriptions noticed at once, and the others use its result. A refresh
 * that fails, or a client holding no refresh token, leaves the original error.
 */
export class TokenStore {
  private tokens: RoomTokens;
  private inflight: Promise<void> | undefined;

  constructor(
    tokens: string | RoomTokens,
    private readonly refreshUrl: string,
    private readonly fetchImpl: FetchLike,
    private readonly retry: RetryOptions | undefined,
    private readonly options: TokenOptions = {},
  ) {
    this.tokens = typeof tokens === "string" ? { access_token: tokens } : { ...tokens };
  }

  get access(): string {
    return this.tokens.access_token;
  }

  get canRefresh(): boolean {
    return typeof this.tokens.refresh_token === "string" && this.tokens.refresh_token !== "";
  }

  /**
   * Renew after `failed` (the access token that was refused) stopped working. True when a newer
   * token is now held (this call's or another's refresh), false when it can't be renewed.
   */
  async refreshAfter(failed: string): Promise<boolean> {
    if (this.tokens.access_token !== failed) return true; // already renewed by someone else
    if (!this.canRefresh) return false;
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = undefined;
    });
    try {
      await this.inflight;
      return true;
    } catch (error) {
      if (error instanceof CrossoverError && error.code === "UNAUTHENTICATED") return false;
      throw error;
    }
  }

  private async doRefresh(): Promise<void> {
    const { json } = await postJson(
      this.fetchImpl,
      this.refreshUrl,
      undefined,
      { refresh_token: this.tokens.refresh_token },
      this.retry,
    );
    const pair = json as RoomTokens;
    this.tokens = { ...pair };
    await this.options.onTokens?.({ ...pair });
  }
}
