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

/** Receives the events published for a room (§20). */
export interface EventSubscriber {
  /**
   * Call `handler` for every event published on `roomId` from now on. Resolves once the
   * subscription is live, with a function that ends it. Messages can be missed (Redis
   * pub/sub is best effort), so a consumer that needs every event backfills from the ledger.
   */
  subscribe(roomId: string, handler: (event: RoomEvent) => void): Promise<() => Promise<void>>;
}

/**
 * One Redis connection in subscriber mode for the whole node, fanning each room's channel out
 * to its local listeners. Messages that `parse` rejects (returns `undefined`) are dropped.
 */
export class RedisRoomFanout<T> {
  private readonly redis: Redis;
  private readonly handlers = new Map<string, Set<(message: T) => void>>();

  constructor(
    url: string,
    private readonly channelOf: (roomId: string) => string,
    parse: (raw: string) => T | undefined,
    options: RedisOptions = {},
  ) {
    this.redis = new Redis(url, {
      retryStrategy: (n: number) => Math.min(n * 200, 2_000),
      ...options,
    } as never);
    this.redis.on("error", () => {});
    this.redis.on("message", (channel: string, raw: string) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      let message: T | undefined;
      try {
        message = parse(raw);
      } catch {
        return;
      }
      if (message === undefined) return;
      for (const handler of [...set]) {
        try {
          handler(message);
        } catch {
          // One listener's failure must not stop the others.
        }
      }
    });
  }

  async subscribe(roomId: string, handler: (message: T) => void) {
    const channel = this.channelOf(roomId);
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.redis.subscribe(channel);
    }
    set.add(handler);
    return async () => {
      const current = this.handlers.get(channel);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(channel);
        await this.redis.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

/** Room events from Redis, one subscriber connection per node. */
export class RedisEventSubscriber extends RedisRoomFanout<RoomEvent> implements EventSubscriber {
  constructor(url: string, options: RedisOptions = {}) {
    super(url, roomChannel, (raw) => JSON.parse(raw) as RoomEvent, options);
  }
}
