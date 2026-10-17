import { Redis, type RedisOptions } from "ioredis";

const REDIS_STORE_OPTIONS: RedisOptions = {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 1_000,
  commandTimeout: 500,
  retryStrategy: (times: number) => Math.min(times * 200, 2_000),
};

/** Create a Redis client with an error listener so connection failures surface at call sites. */
export function createRedisClient(url: string, options: RedisOptions = REDIS_STORE_OPTIONS): Redis {
  const redis = new Redis(url, options as never);
  redis.on("error", () => {});
  return redis;
}

/** Shared connection setup and lifecycle for Redis-backed gateway stores. */
export abstract class RedisBackedStore {
  protected readonly redis: Redis;
  private readonly ownsClient: boolean;

  protected constructor(source: string | Redis) {
    if (typeof source === "string") {
      this.redis = createRedisClient(source);
      this.ownsClient = true;
    } else {
      this.redis = source;
      this.ownsClient = false;
    }
  }

  protected async waitForRedis(timeoutMs: number, notReadyMessage: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.redis.off("ready", onReady);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onReady = () => {
        void this.redis.ping().then(
          () => finish(),
          (error: unknown) => finish(error),
        );
      };
      const timer = setTimeout(() => finish(new Error(notReadyMessage)), timeoutMs);
      if (this.redis.status === "ready") onReady();
      else this.redis.once("ready", onReady);
    });
  }

  protected async closeRedis(): Promise<void> {
    if (this.ownsClient) await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
