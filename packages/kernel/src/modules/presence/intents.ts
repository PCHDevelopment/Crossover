import { Redis, type RedisOptions } from "ioredis";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher, CommandContext } from "../../dispatcher.js";
import { RedisRoomFanout } from "../../publisher.js";
import { filterReadablePaths } from "./readable-paths.js";

export const EDIT_INTENT_TTL_MS = 45_000;

export interface EditIntentRange {
  path: string;
  start_line: number;
  end_line: number;
}

export interface EditIntentValue {
  paths: string[];
  ranges: EditIntentRange[];
  task_id: string | null;
}

export interface EditIntent extends EditIntentValue {
  participant_id: string;
  expires_at: string;
}

export interface EditIntentStore {
  set(roomId: string, participantId: string, intent: EditIntentValue): Promise<string>;
  clear(roomId: string, participantId: string): Promise<void>;
  list(roomId: string): Promise<EditIntent[]>;
  close(): Promise<void>;
}

/** A room-level invalidation; subscribers reload through `presence.list_intents` for ACL filtering. */
export interface EditIntentSubscriber {
  subscribe(roomId: string, handler: () => void): Promise<() => Promise<void>>;
}

/** Ephemeral, room-scoped Redis state for edit intents (§11.4, §19.3). */
export class RedisEditIntentStore implements EditIntentStore {
  private readonly redis: Redis;
  private readonly ownsClient: boolean;
  private readonly ttlMs: number;

  constructor(source: string | Redis, options: { ttlMs?: number; redis?: RedisOptions } = {}) {
    this.ttlMs = options.ttlMs ?? EDIT_INTENT_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) {
      throw new RangeError("Edit intent TTL must be a positive safe integer");
    }
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

  /** Wait for Redis before serving intents, since the client intentionally has no offline queue. */
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

  async set(roomId: string, participantId: string, intent: EditIntentValue): Promise<string> {
    const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
    const value: EditIntent = { ...intent, participant_id: participantId, expires_at: expiresAt };
    await this.redis
      .multi()
      .set(intentKey(roomId, participantId), JSON.stringify(value), "PX", this.ttlMs)
      .publish(editIntentChannel(roomId), "changed")
      .exec();
    return expiresAt;
  }

  async clear(roomId: string, participantId: string): Promise<void> {
    await this.redis
      .multi()
      .del(intentKey(roomId, participantId))
      .publish(editIntentChannel(roomId), "changed")
      .exec();
  }

  async list(roomId: string): Promise<EditIntent[]> {
    const prefix = intentPrefix(roomId);
    let cursor = "0";
    const keys: string[] = [];
    do {
      const [next, batch] = await this.redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", "100");
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    if (keys.length === 0) return [];

    const values = await this.redis.mget(...keys);
    const intents: EditIntent[] = [];
    for (let i = 0; i < keys.length; i++) {
      const raw = values[i];
      if (raw === null || raw === undefined) continue; // TTL may expire after SCAN.
      try {
        const candidate = JSON.parse(raw) as EditIntent;
        if (typeof candidate.participant_id === "string") intents.push(candidate);
      } catch {
        // Ignore values that do not belong to this version of the intent store.
      }
    }
    intents.sort((a, b) =>
      a.participant_id < b.participant_id ? -1 : a.participant_id > b.participant_id ? 1 : 0,
    );
    return intents;
  }

  async close(): Promise<void> {
    if (this.ownsClient) this.redis.disconnect();
  }
}

/** Invalidation-only channel: intent paths are re-read through the reader-filtered command. */
export const editIntentChannel = (roomId: string): string =>
  `presence:intent:live:${encodeURIComponent(roomId)}`;

/** Best-effort room fanout for intent changes, separate from the durable event stream. */
export class RedisEditIntentSubscriber
  extends RedisRoomFanout<true>
  implements EditIntentSubscriber
{
  constructor(url: string, options: RedisOptions = {}) {
    super(url, editIntentChannel, (raw) => (raw === "changed" ? true : undefined), options);
  }
}

/** Register set/clear and list commands; `normalizePath` is shared with workspace writes. */
export function registerPresenceIntentCommands(
  dispatcher: Dispatcher,
  store: EditIntentStore,
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
  const line = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
  const range = z
    .strictObject({ path, start_line: line, end_line: line })
    .refine((value) => value.start_line <= value.end_line, {
      message: "start_line must be less than or equal to end_line",
      path: ["end_line"],
    });
  const setParams = z
    .strictObject({
      paths: z
        .array(path)
        .min(1)
        .max(50)
        .transform((paths) => [...new Set(paths)]),
      ranges: z.array(range).max(50).optional(),
      task_id: z.string().min(1).max(100).optional(),
    })
    .superRefine((value, ctx) => {
      const paths = new Set(value.paths);
      for (const [index, item] of (value.ranges ?? []).entries()) {
        if (!paths.has(item.path)) {
          ctx.addIssue({
            code: "custom",
            message: "Range path must also appear in paths",
            path: ["ranges", index, "path"],
          });
        }
      }
    });

  dispatcher.registerCommand({
    method: "presence.set_intent",
    action: "presence.update",
    mutating: false,
    view: "own",
    params: setParams,
    execute: async (ctx, params) => {
      if (params.task_id !== undefined) await requireRoomTask(ctx, params.task_id);
      const expires_at = await store.set(ctx.room_id, ctx.principal.participant_id, {
        paths: params.paths,
        ranges: params.ranges ?? [],
        task_id: params.task_id ?? null,
      });
      return { response: { expires_at } };
    },
  });

  dispatcher.registerCommand({
    method: "presence.clear_intent",
    action: "presence.update",
    mutating: false,
    view: "own",
    params: z.strictObject({}),
    execute: async (ctx) => {
      await store.clear(ctx.room_id, ctx.principal.participant_id);
      return { response: { cleared: true } };
    },
  });

  dispatcher.registerCommand({
    method: "presence.list_intents",
    action: "room.read",
    mutating: false,
    view: "participant",
    params: z.strictObject({}),
    execute: async (ctx) => {
      // An intent names the paths someone is about to edit, so a reader sees only the paths
      // they may read: others are left out, and an intent with none left is left out whole
      // (its task link with it), so a denied path is neither named nor hinted at (§34.5).
      const stored = await store.list(ctx.room_id);
      const visible = new Set(
        await filterReadablePaths(
          stored.flatMap(({ paths }) => paths),
          async (path) => {
            try {
              await ctx.authorize("workspace.read", { path });
              return true;
            } catch (error) {
              if (error instanceof CrossoverError && error.code === "FORBIDDEN") return false;
              throw error;
            }
          },
        ),
      );
      const intents = [];
      for (const intent of stored) {
        const paths = intent.paths.filter((path) => visible.has(path));
        if (paths.length === 0) continue;
        const keep = new Set(paths);
        intents.push({
          ...intent,
          paths,
          ranges: intent.ranges.filter((r) => keep.has(r.path)),
        });
      }
      return { response: { intents } };
    },
  });
}

async function requireRoomTask(ctx: CommandContext, taskId: string): Promise<void> {
  const { rowCount } = await ctx.client.query(
    "SELECT 1 FROM tasks WHERE id = $1 AND room_id = $2",
    [taskId, ctx.room_id],
  );
  if (rowCount === 0) throw new CrossoverError("NOT_FOUND", `Task ${taskId} not found`);
}

function intentPrefix(roomId: string): string {
  return `presence:intent:${encodeURIComponent(roomId)}:`;
}

function intentKey(roomId: string, participantId: string): string {
  return `${intentPrefix(roomId)}${encodeURIComponent(participantId)}`;
}
