import type { RoomEvent } from "@crossover/protocol";
import { Redis, type RedisOptions } from "ioredis";

/**
 * Sends committed events to live subscribers. The `events` table is the outbox (§19.2):
 * a missed or failed publish is recovered by backfilling from the table, so publishing is
 * best effort and must never decide whether a command succeeds.
 */
export interface EventPublisher {
  /** Publish `events` (ascending sequence, all for `roomId`) in order. */
  publish(roomId: string, events: readonly RoomEvent[]): Promise<void>;
}

/** The Redis pub/sub channel for a room (§19.2). */
export function roomChannel(roomId: string): string {
  return `room:${roomId}`;
}

/**
 * Publishes each event as its own JSON message (the §19.1 shape) on `room:{roomId}`.
 *
 * By default it creates a client that fails fast when Redis is unreachable
 * (`enableOfflineQueue: false`, one retry per request, short connect timeout), so a Redis
 * outage costs a command milliseconds, not a hang. Pass your own `Redis` to share a
 * connection; it is then not closed by {@link close}.
 */
export class RedisEventPublisher implements EventPublisher {
  private readonly redis: Redis;
  private readonly ownsClient: boolean;

  constructor(source: string | Redis, options: RedisOptions = {}) {
    if (typeof source === "string") {
      const merged: RedisOptions = {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1_000,
        // Keep trying to reconnect in the background, backing off to 2 s.
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
        ...options,
      };
      this.redis = new Redis(source, merged as never);
      // Connection errors surface through publish() rejecting; don't also crash on 'error'.
      this.redis.on("error", () => {});
      this.ownsClient = true;
    } else {
      this.redis = source;
      this.ownsClient = false;
    }
  }

  /**
   * Resolve once the connection is ready. The default client doesn't queue commands while
   * disconnected (so an outage can't stall commands), which also means a publish issued
   * before the first connection completes fails; call this at startup. Rejects after
   * `timeoutMs`.
   */
  ready(timeoutMs = 5_000): Promise<void> {
    if (this.redis.status === "ready") return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.redis.off("ready", onReady);
        reject(new Error(`Redis not ready after ${timeoutMs} ms`));
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.redis.once("ready", onReady);
    });
  }

  async publish(roomId: string, events: readonly RoomEvent[]): Promise<void> {
    if (events.length === 0) return;
    const channel = roomChannel(roomId);
    // One pipeline: the messages go out in order in one round trip.
    const pipeline = this.redis.pipeline();
    for (const event of events) pipeline.publish(channel, JSON.stringify(event));
    const results = await pipeline.exec();
    for (const [error] of results ?? []) {
      if (error) throw error;
    }
  }

  /** Close the connection if this publisher created it. */
  async close(): Promise<void> {
    if (this.ownsClient) this.redis.disconnect();
  }
}
