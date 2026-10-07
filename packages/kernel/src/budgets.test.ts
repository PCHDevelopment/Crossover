import type { Pool } from "@crossover/db";
import { Redis } from "ioredis";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUDGET_DEFAULTS,
  budgetsOf,
  limitFor,
  MemoryBudgetLimiter,
  readOverrides,
  RedisBudgetLimiter,
  type BudgetLimiter,
} from "./budgets.js";
import { Dispatcher } from "./dispatcher.js";
import { registerMessageCommands } from "./modules/messages/messages.js";
import type { Principal } from "./principal.js";

let db: TestDatabase;
let pool: Pool;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});
afterAll(async () => {
  await db.drop();
});

const cmd = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `k-${++n}`,
});
const read = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
});

async function setup(
  options: { settings?: object; limiter?: BudgetLimiter; clock?: () => number } = {},
) {
  const limiter = options.limiter ?? new MemoryBudgetLimiter(options.clock);
  const warnings: unknown[] = [];
  const d = new Dispatcher({
    pool,
    authorize,
    nodeId: `node-${++n}`,
    budgets: limiter,
    onBudgetError: (error) => warnings.push(error),
  });
  registerMessageCommands(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id, settings)
     VALUES ($1, $1, 'n', 'o', 'x', $2::jsonb)`,
    [room, JSON.stringify(options.settings ?? {})],
  );
  const add = async (kind: "HUMAN" | "AGENT", budgets: object = {}): Promise<Principal> => {
    const id = newId("part");
    await pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status, budgets)
       VALUES ($1, $2, $3, $1, 'MEMBER', 'DEVELOPER', 'ACTIVE', $4::jsonb)`,
      [id, room, kind, JSON.stringify(budgets)],
    );
    return {
      participant_id: id,
      room_id: room,
      kind,
      authority: "MEMBER",
      role: "DEVELOPER",
    } as Principal;
  };
  const send = (p: Principal) => d.dispatch(p, cmd("messages.send", { body: "hi" }));
  const events = async () =>
    (
      await pool.query(
        "SELECT actor_id, payload FROM events WHERE room_id = $1 AND type = 'budget.exceeded' ORDER BY sequence",
        [room],
      )
    ).rows;
  return { d, room, add, send, events, warnings, limiter };
}

const exceeded = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe("BUDGET_EXCEEDED");
  expect((err as CrossoverError).retryable).toBe(true);
  return (err as CrossoverError).details as Record<string, number | string>;
};

describe("budget rules", () => {
  it("every command is a command; some are also a message, a ChangeSet or a tool call", () => {
    expect(budgetsOf("tasks.list")).toEqual(["commands"]);
    expect(budgetsOf("messages.send")).toEqual(["commands", "messages"]);
    expect(budgetsOf("workspace.apply_changeset")).toEqual(["commands", "changesets"]);
    expect(budgetsOf("tools.invoke")).toEqual(["commands", "tool_invocations"]);
    expect(BUDGET_DEFAULTS).toMatchObject({
      commands: { limit: 120, windowMs: 60_000 },
      messages: { limit: 10, windowMs: 60_000 },
      changesets: { limit: 60, windowMs: 3_600_000 },
      tool_invocations: { limit: 100, windowMs: 3_600_000 },
    });
  });

  it("the participant's setting beats the room's, which beats the default; null is unlimited; junk is ignored", () => {
    const room = readOverrides({
      messages: 4,
      commands: null,
      changesets: 0,
      tool_invocations: "x",
    });
    const mine = readOverrides({ messages: 7 });
    expect(limitFor("messages", room, mine)).toBe(7);
    expect(limitFor("messages", room, {})).toBe(4);
    expect(limitFor("commands", room, {})).toBeNull();
    expect(limitFor("changesets", room, {})).toBe(60);
    expect(limitFor("tool_invocations", room, {})).toBe(100);
    expect(readOverrides("nope")).toEqual({});
    expect(readOverrides([1])).toEqual({});
  });
});

describe("budgets in the dispatcher (§22.3, T904)", () => {
  it("an agent's 11th message in a minute is BUDGET_EXCEEDED with retry_after; the window resets", async () => {
    let now = 1_000_000 * 60_000; // the start of a window
    const s = await setup({ clock: () => now });
    const a = await s.add("AGENT");
    for (let i = 0; i < 10; i++) await s.send(a);
    now += 20_000;
    const details = await exceeded(s.send(a));
    expect(details).toMatchObject({
      budget: "messages",
      limit: 10,
      window_seconds: 60,
      retry_after: 40,
    });
    now += 40_000; // the next window
    await s.send(a);
  });

  it("the room hears of it once per window, however many calls are refused", async () => {
    let now = 2_000_000 * 60_000;
    const s = await setup({ settings: { budgets: { messages: 1 } }, clock: () => now });
    const a = await s.add("AGENT");
    await s.send(a);
    for (let i = 0; i < 4; i++) await exceeded(s.send(a));
    const events = await s.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_id: a.participant_id,
      payload: { budget: "messages", limit: 1, method: "messages.send", retry_after: 60 },
    });
    now += 60_000;
    await s.send(a);
    await exceeded(s.send(a));
    expect(await s.events()).toHaveLength(2);
  });

  it("commands are counted too: the 121st read in a minute is refused", async () => {
    const s = await setup();
    const a = await s.add("AGENT");
    for (let i = 0; i < 120; i++) await s.d.dispatch(a, read("messages.list"));
    expect(await exceeded(s.d.dispatch(a, read("messages.list")))).toMatchObject({
      budget: "commands",
      limit: 120,
    });
  });

  it("budgets are per participant, and humans have none", async () => {
    const s = await setup({ settings: { budgets: { messages: 2 } } });
    const a = await s.add("AGENT");
    const b = await s.add("AGENT");
    const h = await s.add("HUMAN");
    await s.send(a);
    await s.send(a);
    await exceeded(s.send(a));
    await s.send(b);
    for (let i = 0; i < 15; i++) await s.send(h);
  });

  it("the owner's overrides apply: the participant's over the room's, and null removes the limit", async () => {
    const s = await setup({ settings: { budgets: { messages: 2 } } });
    const roomLimited = await s.add("AGENT");
    const generous = await s.add("AGENT", { messages: 4 });
    const unlimited = await s.add("AGENT", { messages: null });
    for (let i = 0; i < 2; i++) await s.send(roomLimited);
    await exceeded(s.send(roomLimited));
    for (let i = 0; i < 4; i++) await s.send(generous);
    await exceeded(s.send(generous));
    for (let i = 0; i < 12; i++) await s.send(unlimited);
  });

  it("a retry of a command that already ran is replayed without being charged or refused", async () => {
    const s = await setup({ settings: { budgets: { messages: 2 } } });
    const a = await s.add("AGENT");
    const first = cmd("messages.send", { body: "one" });
    const last = cmd("messages.send", { body: "two" }); // the limit-th message
    await s.d.dispatch(a, first);
    const done = await s.d.dispatch(a, last);
    expect(done.replayed).toBe(false);
    // The response was lost; the agent retries with the same key.
    const retry = await s.d.dispatch(a, last);
    expect(retry.replayed).toBe(true);
    expect(retry.response).toEqual(done.response);
    expect(await s.events()).toEqual([]); // no budget.exceeded
    // The retries cost nothing: a new message is what is refused, once.
    await exceeded(s.send(a));
    await s.d.dispatch(a, last);
    expect(await s.events()).toHaveLength(1);
  });

  it("a request reusing a key with other content isn't a replay: it is charged", async () => {
    const s = await setup({ settings: { budgets: { messages: 1 } } });
    const a = await s.add("AGENT");
    const first = cmd("messages.send", { body: "one" });
    await s.d.dispatch(a, first);
    await exceeded(s.d.dispatch(a, { ...first, id: newId("cmd"), params: { body: "different" } }));
  });

  it("a command refused for one budget spends none of the others", async () => {
    const s = await setup({ settings: { budgets: { messages: 1, commands: 5 } } });
    const a = await s.add("AGENT");
    await s.send(a); // 1 command, 1 message
    for (let i = 0; i < 20; i++) await exceeded(s.send(a)); // refused: costs no command
    for (let i = 0; i < 4; i++) await s.d.dispatch(a, read("messages.list")); // commands 2..5
    await exceeded(s.d.dispatch(a, read("messages.list")));
  });

  it("with the limiter down the command goes ahead, and the failure is reported", async () => {
    const broken: BudgetLimiter = {
      peek: async () => {
        throw new Error("redis is down");
      },
      consume: async () => {
        throw new Error("redis is down");
      },
      close: async () => {},
    };
    const s = await setup({ limiter: broken });
    const a = await s.add("AGENT");
    await s.send(a);
    await s.send(a);
    expect(s.warnings).toHaveLength(2);
  });
});

describe("RedisBudgetLimiter", () => {
  it("counts per window in Redis, tells the first refusal, and resets with the window", async () => {
    let now = 3_000_000 * 60_000;
    const limiter = new RedisBudgetLimiter(
      process.env["REDIS_URL"] ?? "redis://localhost:6379",
      () => now,
    );
    try {
      await limiter.ready();
      const key = {
        room_id: newId("room"),
        participant_id: newId("part"),
        budget: "messages" as const,
      };
      expect(await limiter.peek(key, 60_000)).toBe(0);
      expect(await limiter.consume(key, 2, 60_000)).toEqual({ allowed: true });
      expect(await limiter.consume(key, 2, 60_000)).toEqual({ allowed: true });
      expect(await limiter.peek(key, 60_000)).toBe(2);
      // The counter always carries its expiry (set in the same step as the first increment).
      const probe = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379");
      try {
        const ttl = await probe.pttl(
          `budget:${key.room_id}:${key.participant_id}:messages:${Math.floor(now / 60_000)}`,
        );
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(120_000);
      } finally {
        probe.disconnect();
      }
      now += 15_000;
      expect(await limiter.consume(key, 2, 60_000)).toEqual({
        allowed: false,
        retry_after_ms: 45_000,
        first: true,
      });
      expect(await limiter.consume(key, 2, 60_000)).toMatchObject({ allowed: false, first: false });
      expect(await limiter.consume({ ...key, participant_id: "part_other" }, 2, 60_000)).toEqual({
        allowed: true,
      });
      now += 45_000;
      expect(await limiter.consume(key, 2, 60_000)).toEqual({ allowed: true });
    } finally {
      await limiter.close();
    }
  });
});
