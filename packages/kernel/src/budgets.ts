import { Redis } from "ioredis";

/**
 * Per-agent budgets (§22.3). Each is a count over a fixed window, per participant in a room.
 * (Sandbox compute, the fifth line of the table, is the execution service's.)
 */
export const BUDGET_DEFAULTS = {
  commands: { limit: 120, windowMs: 60_000 },
  messages: { limit: 10, windowMs: 60_000 },
  changesets: { limit: 60, windowMs: 3_600_000 },
  tool_invocations: { limit: 100, windowMs: 3_600_000 },
} as const;

export type BudgetName = keyof typeof BUDGET_DEFAULTS;
export const BUDGET_NAMES = Object.keys(BUDGET_DEFAULTS) as BudgetName[];

/** The budgets a method draws on: every command counts as one, and some count as another too. */
export function budgetsOf(method: string): BudgetName[] {
  const names: BudgetName[] = ["commands"];
  if (method === "messages.send") names.push("messages");
  if (method === "workspace.apply_changeset" || method === "changes.submit") {
    names.push("changesets");
  }
  if (method === "tools.invoke") names.push("tool_invocations");
  return names;
}

/** A limit as the owner configures it: a count, or `null` for no limit. */
export type BudgetOverrides = Partial<Record<BudgetName, number | null>>;

const validOverride = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1);

/** What `overrides` (from `settings.budgets` or `participants.budgets`) say, ignoring anything malformed. */
export function readOverrides(raw: unknown): BudgetOverrides {
  const found: BudgetOverrides = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return found;
  for (const name of BUDGET_NAMES) {
    const value = (raw as Record<string, unknown>)[name];
    if (value !== undefined && validOverride(value)) found[name] = value;
  }
  return found;
}

/** Combine configured limits by the tighter cap; an omitted value inherits, and `null` is unlimited. */
export function limitFor(
  name: BudgetName,
  room: BudgetOverrides,
  participant: BudgetOverrides,
): number | null {
  const hasRoomLimit = Object.hasOwn(room, name);
  const hasParticipantLimit = Object.hasOwn(participant, name);
  if (!hasRoomLimit && !hasParticipantLimit) return BUDGET_DEFAULTS[name].limit;
  if (!hasRoomLimit) return participant[name] ?? null;
  if (!hasParticipantLimit) return room[name] ?? null;

  const roomLimit = room[name];
  const participantLimit = participant[name];
  if (roomLimit === null) return participantLimit ?? null;
  if (participantLimit === null) return roomLimit ?? null;
  if (roomLimit === undefined) return participantLimit ?? null;
  if (participantLimit === undefined) return roomLimit;
  return Math.min(roomLimit, participantLimit);
}

export interface BudgetKey {
  room_id: string;
  participant_id: string;
  budget: BudgetName;
}

export type BudgetDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** Milliseconds until the window resets. */
      retry_after_ms: number;
      /** True for the first refusal of this window: the one that is told to the room. */
      first: boolean;
    };

export interface BudgetLimiter {
  /** How many uses the current window has counted so far, without counting one. */
  peek(key: BudgetKey, windowMs: number): Promise<number>;
  /** Count one use against `limit` per `windowMs`, and say whether it is within it. */
  consume(key: BudgetKey, limit: number, windowMs: number): Promise<BudgetDecision>;
  close(): Promise<void>;
}

const decide = (count: number, limit: number, windowMs: number, now: number): BudgetDecision =>
  count <= limit
    ? { allowed: true }
    : {
        allowed: false,
        retry_after_ms: (Math.floor(now / windowMs) + 1) * windowMs - now,
        first: count === limit + 1,
      };

const windowKey = (key: BudgetKey, windowMs: number, now: number) =>
  `budget:${key.room_id}:${key.participant_id}:${key.budget}:${Math.floor(now / windowMs)}`;

const INCR_WITH_EXPIRY = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n`;

/** Counters in memory, with a clock you can move; for tests and single-process use. */
export class MemoryBudgetLimiter implements BudgetLimiter {
  private readonly counts = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  async peek(key: BudgetKey, windowMs: number): Promise<number> {
    return this.counts.get(windowKey(key, windowMs, this.now())) ?? 0;
  }

  async consume(key: BudgetKey, limit: number, windowMs: number): Promise<BudgetDecision> {
    const now = this.now();
    const id = windowKey(key, windowMs, now);
    const count = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, count);
    return decide(count, limit, windowMs, now);
  }

  async close(): Promise<void> {
    this.counts.clear();
  }
}

/**
 * Fixed-window counters in Redis, shared by every node. A window is `floor(now / windowMs)`, so
 * a count resets when the next one starts (a burst can straddle two windows, up to twice the
 * limit; fine for a safety budget). The client has no offline queue: with Redis down `consume`
 * rejects at once, and the dispatcher lets the command through (see `onBudgetError`).
 */
export class RedisBudgetLimiter implements BudgetLimiter {
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
        // A Redis that is connected but not answering must not hang every agent command.
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

  /** Wait for Redis to be connected: the client has no offline queue, so commands before that fail. */
  async ready(timeoutMs = 5_000): Promise<void> {
    if (this.redis.status === "ready") return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.redis.off("ready", onReady);
        reject(new Error(`Budget Redis not ready after ${timeoutMs} ms`));
      }, timeoutMs);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.redis.once("ready", onReady);
    });
  }

  async peek(key: BudgetKey, windowMs: number): Promise<number> {
    const value = await this.redis.get(windowKey(key, windowMs, this.now()));
    return value === null ? 0 : Number(value);
  }

  async consume(key: BudgetKey, limit: number, windowMs: number): Promise<BudgetDecision> {
    const now = this.now();
    const id = windowKey(key, windowMs, now);
    // One round trip, so a counter can't be left without its expiry.
    const count = Number(await this.redis.eval(INCR_WITH_EXPIRY, 1, id, String(windowMs * 2)));
    return decide(count, limit, windowMs, now);
  }

  async close(): Promise<void> {
    if (this.ownsClient) await this.redis.quit().catch(() => undefined);
  }
}
