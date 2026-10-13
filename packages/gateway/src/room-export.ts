import { randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import { Redis } from "ioredis";
import { CrossoverError } from "@crossover/protocol";

const WINDOW_MS = 60 * 60_000;
const ROOM_LIMIT = 5;
const ACTOR_LIMIT = 2;
const LOCK_TTL_MS = 60 * 60_000;

const ACQUIRE = `
if redis.call('EXISTS', KEYS[3]) == 1 then return {0, 'busy', redis.call('PTTL', KEYS[3])} end
local room_count = tonumber(redis.call('GET', KEYS[1]) or '0')
local actor_count = tonumber(redis.call('GET', KEYS[2]) or '0')
if room_count >= tonumber(ARGV[1]) then return {0, 'room', tonumber(ARGV[3])} end
if actor_count >= tonumber(ARGV[2]) then return {0, 'actor', tonumber(ARGV[3])} end
if not redis.call('SET', KEYS[3], ARGV[4], 'PX', ARGV[5], 'NX') then
  return {0, 'busy', redis.call('PTTL', KEYS[3])}
end
room_count = redis.call('INCR', KEYS[1])
actor_count = redis.call('INCR', KEYS[2])
if room_count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
if actor_count == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
return {1, 'ok', 0}
`;

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/** A distributed admission lock and fixed-window rate limit for expensive room exports. */
export interface RoomExportLimiter {
  acquire(roomId: string, actorId: string): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface RoomExportArchive {
  filename: string;
  /** Last ledger sequence represented by this export's repeatable-read snapshot. */
  ledgerHead: string;
  stream: Readable;
  cleanup(): Promise<void>;
}

export interface RoomExportSource {
  create(roomId: string, signal: AbortSignal): Promise<RoomExportArchive>;
}

/** Production export limits are shared across gateway nodes through Redis. */
export class RedisRoomExportLimiter implements RoomExportLimiter {
  private readonly redis: Redis;
  private readonly ownsClient: boolean;

  constructor(
    source: string | Redis,
    private readonly now: () => number = Date.now,
  ) {
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

  async acquire(roomId: string, actorId: string): Promise<() => Promise<void>> {
    const now = this.now();
    const window = Math.floor(now / WINDOW_MS);
    const keyRoom = `crossover:room-export:room:${encodeURIComponent(roomId)}:${window}`;
    const keyActor = `crossover:room-export:actor:${encodeURIComponent(actorId)}:${window}`;
    const keyLock = `crossover:room-export:lock:${encodeURIComponent(roomId)}`;
    const token = randomBytes(18).toString("base64url");
    try {
      const [allowed, scope, retryAfter] = (await this.redis.eval(
        ACQUIRE,
        3,
        keyRoom,
        keyActor,
        keyLock,
        String(ROOM_LIMIT),
        String(ACTOR_LIMIT),
        String(WINDOW_MS),
        token,
        String(LOCK_TTL_MS),
      )) as [number, string, number];
      if (allowed !== 1) {
        const reason =
          scope === "busy"
            ? "An export is already running for this room"
            : "Export rate limit exceeded";
        throw new CrossoverError("RATE_LIMITED", reason, {
          details: { scope, retry_after_ms: Math.max(1, Number(retryAfter)) },
        });
      }
    } catch (error) {
      if (error instanceof CrossoverError) throw error;
      throw new CrossoverError("UNAVAILABLE", "Room export is temporarily unavailable", {
        cause: error,
      });
    }
    return async () => {
      try {
        await this.redis.eval(RELEASE, 1, keyLock, token);
      } catch (error) {
        throw new CrossoverError("UNAVAILABLE", "Room export lock could not be released", {
          cause: error,
        });
      }
    };
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.redis.quit().catch(() => undefined);
  }
}
