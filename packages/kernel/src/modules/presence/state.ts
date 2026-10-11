import { Redis, type RedisOptions } from "ioredis";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { CommandContext, Dispatcher } from "../../dispatcher.js";
import { RedisRoomFanout } from "../../publisher.js";

/** A presence record lives this long unless refreshed; clients re-send every 15 s (§21). */
export const PRESENCE_TTL_MS = 45_000;
/** Updates allowed per participant per second; cursor moves are throttled client-side to fit. */
export const PRESENCE_UPDATES_PER_SECOND = 20;

export interface PresenceCursor {
  path: string;
  line: number;
  column: number;
  selection?: { start_line: number; start_column: number; end_line: number; end_column: number };
}

export interface PresenceValue {
  status: "active" | "idle";
  open_files: string[];
  cursor: PresenceCursor | null;
}

export interface Presence extends PresenceValue {
  participant_id: string;
  expires_at: string;
}

export interface PresenceStore {
  /** Replace the record and publish it; `undefined` when over the rate limit. */
  update(roomId: string, participantId: string, value: PresenceValue): Promise<string | undefined>;
  list(roomId: string): Promise<Presence[]>;
  close(): Promise<void>;
}

/** Redis channel carrying a room's presence updates, apart from its event channel. */
export const presenceChannel = (roomId: string): string =>
  `presence:live:${encodeURIComponent(roomId)}`;

/** Ephemeral, room-scoped presence (§13.4): never in the ledger. */
export class RedisPresenceStore implements PresenceStore {
  private readonly redis: Redis;
  private readonly ownsClient: boolean;

  constructor(
    source: string | Redis,
    private readonly options: { ttlMs?: number; perSecond?: number; redis?: RedisOptions } = {},
  ) {
    if (typeof source === "string") {
      this.redis = new Redis(source, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1_000,
        retryStrategy: (times: number) => Math.min(times * 200, 2_000),
        ...options.redis,
      } as never);
      this.redis.on("error", () => {});
      this.ownsClient = true;
    } else {
      this.redis = source;
      this.ownsClient = false;
    }
  }

  async ready(timeoutMs = 5_000): Promise<void> {
    if (this.redis.status === "ready") return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.redis.off("ready", onReady);
        reject(new Error(`Presence Redis not ready after ${timeoutMs} ms`));
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.redis.once("ready", onReady);
    });
  }

  async update(roomId: string, participantId: string, value: PresenceValue) {
    // A fixed one-second window per participant.
    const window = `presence:rate:${encodeURIComponent(roomId)}:${encodeURIComponent(participantId)}:${Math.floor(Date.now() / 1000)}`;
    const counted = await this.redis.multi().incr(window).pexpire(window, 2_000).exec();
    const count = Number(counted?.[0]?.[1]);
    if (count > (this.options.perSecond ?? PRESENCE_UPDATES_PER_SECOND)) return undefined;

    const ttlMs = this.options.ttlMs ?? PRESENCE_TTL_MS;
    const expires_at = new Date(Date.now() + ttlMs).toISOString();
    const record: Presence = { ...value, participant_id: participantId, expires_at };
    const json = JSON.stringify(record);
    await this.redis
      .multi()
      .set(stateKey(roomId, participantId), json, "PX", ttlMs)
      .publish(presenceChannel(roomId), json)
      .exec();
    return expires_at;
  }

  async list(roomId: string): Promise<Presence[]> {
    const prefix = statePrefix(roomId);
    let cursor = "0";
    const keys: string[] = [];
    do {
      const [next, batch] = await this.redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", "100");
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    if (keys.length === 0) return [];
    const records: Presence[] = [];
    for (const raw of await this.redis.mget(...keys)) {
      if (raw === null || raw === undefined) continue; // expired after SCAN
      try {
        const record = JSON.parse(raw) as Presence;
        if (typeof record.participant_id === "string") records.push(record);
      } catch {
        // not a record of this version
      }
    }
    return records.sort((a, b) =>
      a.participant_id < b.participant_id ? -1 : a.participant_id > b.participant_id ? 1 : 0,
    );
  }

  async close(): Promise<void> {
    if (this.ownsClient) this.redis.disconnect();
  }
}

/** Receives a room's presence updates as they are published (best effort, like events). */
export interface PresenceSubscriber {
  subscribe(roomId: string, handler: (record: Presence) => void): Promise<() => Promise<void>>;
}

/** Presence updates from Redis, one subscriber connection per node. */
export class RedisPresenceSubscriber
  extends RedisRoomFanout<Presence>
  implements PresenceSubscriber
{
  constructor(url: string, options: RedisOptions = {}) {
    super(url, presenceChannel, parsePresence, options);
  }
}

function parsePresence(raw: string): Presence | undefined {
  const record = JSON.parse(raw) as Partial<Presence> | null;
  return typeof record?.participant_id === "string" &&
    typeof record.expires_at === "string" &&
    Array.isArray(record.open_files)
    ? (record as Presence)
    : undefined;
}

/**
 * What `viewer` may see of a record: open files they can't read are left out, and so is a cursor
 * on one, so a path they may not read is never named (§34.5). The status always shows.
 */
export async function presenceFor(
  record: Presence,
  mayRead: (path: string) => Promise<boolean>,
): Promise<Presence> {
  const open_files: string[] = [];
  for (const path of record.open_files) if (await mayRead(path)) open_files.push(path);
  const cursor = record.cursor && open_files.includes(record.cursor.path) ? record.cursor : null;
  return { ...record, open_files, cursor };
}

/** `workspace.read` on a path, as a yes or no, remembered for the command. */
export function pathReader(ctx: CommandContext): (path: string) => Promise<boolean> {
  const known = new Map<string, boolean>();
  return async (path) => {
    const cached = known.get(path);
    if (cached !== undefined) return cached;
    let allowed = true;
    try {
      await ctx.authorize("workspace.read", { path });
    } catch (error) {
      if (!(error instanceof CrossoverError) || error.code !== "FORBIDDEN") throw error;
      allowed = false;
    }
    known.set(path, allowed);
    return allowed;
  };
}

export function registerPresenceCommands(
  dispatcher: Dispatcher,
  store: PresenceStore,
  normalizePath: (path: string) => string,
): void {
  const path = z.string().transform((input, ctx) => {
    try {
      return normalizePath(input);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid path",
      });
      return z.NEVER;
    }
  });
  const position = z.number().int().min(1).max(10_000_000);
  const params = z
    .strictObject({
      status: z.enum(["active", "idle"]).default("active"),
      open_files: z
        .array(path)
        .max(20)
        .default([])
        .transform((paths) => [...new Set(paths)]),
      cursor: z
        .strictObject({
          path,
          line: position,
          column: position,
          selection: z
            .strictObject({
              start_line: position,
              start_column: position,
              end_line: position,
              end_column: position,
            })
            .refine(
              (s) =>
                s.start_line < s.end_line ||
                (s.start_line === s.end_line && s.start_column <= s.end_column),
              { message: "A selection starts before it ends" },
            )
            .optional(),
        })
        .nullable()
        .default(null),
    })
    .refine((value) => !value.cursor || value.open_files.includes(value.cursor.path), {
      message: "The cursor's path must be one of open_files",
      path: ["cursor", "path"],
    });

  dispatcher.registerCommand({
    method: "presence.update",
    action: "presence.update",
    mutating: false,
    view: "own",
    params,
    execute: async (ctx, value) => {
      const expires_at = await store.update(ctx.room_id, ctx.principal.participant_id, {
        status: value.status,
        open_files: value.open_files,
        cursor: value.cursor
          ? {
              path: value.cursor.path,
              line: value.cursor.line,
              column: value.cursor.column,
              ...(value.cursor.selection ? { selection: value.cursor.selection } : {}),
            }
          : null,
      });
      if (expires_at === undefined)
        throw new CrossoverError("RATE_LIMITED", "Too many presence updates", {
          details: { reason: "presence_rate", retry_after: 1 },
        });
      return { response: { expires_at } };
    },
  });

  dispatcher.registerCommand({
    method: "presence.list",
    action: "room.read",
    mutating: false,
    view: "participant",
    params: z.strictObject({}),
    execute: async (ctx) => {
      const mayRead = pathReader(ctx);
      const presence: Presence[] = [];
      for (const record of await store.list(ctx.room_id))
        presence.push(await presenceFor(record, mayRead));
      return { response: { presence } };
    },
  });
}

function statePrefix(roomId: string): string {
  return `presence:state:${encodeURIComponent(roomId)}:`;
}

function stateKey(roomId: string, participantId: string): string {
  return `${statePrefix(roomId)}${encodeURIComponent(participantId)}`;
}
