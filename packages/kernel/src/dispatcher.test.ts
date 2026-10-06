import { withTransaction, type Pool, type PoolClient } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { acquireLease, getLease } from "@crossover/ledger";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Principal } from "./principal.js";
import {
  allowAll,
  Dispatcher,
  type Authorizer,
  type DispatcherOptions,
  type CommandResult,
  type EmittedEvent,
} from "./dispatcher.js";

let db: TestDatabase;
let pool: Pool;
let counter = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  await pool.query("CREATE TABLE side_effects (id serial PRIMARY KEY, room_id text, tag text)");
});

afterAll(async () => {
  await db.drop();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function newRoom(): Promise<string> {
  const id = `room_${++counter}`;
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'part_1')`,
    [id],
  );
  return id;
}

const principal = (room_id: string, participant_id = "part_1"): Principal => ({
  participant_id,
  room_id,
  kind: "HUMAN",
  authority: "MEMBER",
  role: "DEVELOPER",
});

const envelope = (method: string, params: Record<string, unknown> = {}, key?: string) => ({
  id: newId("cmd"),
  method,
  params,
  ...(key !== undefined ? { idempotency_key: key } : {}),
});

let keyN = 0;
const nextKey = () => `key-${++keyN}`;

function dispatcher(
  authorize: Authorizer = allowAll,
  nodeId = `node-${++counter}`,
  extra: Partial<DispatcherOptions> = {},
) {
  return new Dispatcher({ pool, authorize, nodeId, ...extra });
}

/** A mutating command that writes a side-effect row and emits `n` message.sent events. */
function registerSay(d: Dispatcher): void {
  d.registerCommand({
    method: "messages.send",
    params: z.object({ body: z.string().min(1), n: z.number().int().min(0).default(1) }),
    mutating: true,
    execute: async (ctx, p) => {
      await ctx.client.query("INSERT INTO side_effects (room_id, tag) VALUES ($1, $2)", [
        ctx.room_id,
        p.body,
      ]);
      return {
        response: { said: p.body },
        events: Array.from({ length: p.n }, (_, i) => ({
          type: "message.sent" as const,
          payload: { body: p.body, i },
        })),
      };
    },
  });
}

const effects = async (room: string) =>
  (
    await pool.query("SELECT tag FROM side_effects WHERE room_id = $1 ORDER BY id", [room])
  ).rows.map((r) => r.tag as string);
const lastSeq = async (room: string) =>
  Number(
    (await pool.query("SELECT last_sequence FROM rooms WHERE id = $1", [room])).rows[0]
      .last_sequence,
  );
const eventRows = async (room: string) =>
  (await pool.query("SELECT * FROM events WHERE room_id = $1 ORDER BY sequence", [room])).rows;

describe("dispatch: routing and validation", () => {
  it("unknown method → NOT_FOUND", async () => {
    const room = await newRoom();
    const d = dispatcher();
    registerSay(d);
    const err = await d
      .dispatch(principal(room), envelope("tasks.exploded", {}, "k"))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossoverError);
    expect(err).toMatchObject({ code: "NOT_FOUND", details: { method: "tasks.exploded" } });
  });

  it("a catalog method nobody registered → NOT_FOUND too", async () => {
    const room = await newRoom();
    const d = dispatcher();
    await expect(
      d.dispatch(principal(room), envelope("tasks.claim", {}, "k")),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("a malformed envelope → VALIDATION with the zod issues", async () => {
    const room = await newRoom();
    const d = dispatcher();
    registerSay(d);
    for (const bad of [
      null,
      "x",
      {},
      { ...envelope("messages.send", { body: "hi" }), id: "nope" },
      envelope("messages.send", { body: "hi" }), // mutating without an idempotency key
    ]) {
      const err = await d.dispatch(principal(room), bad).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "VALIDATION" });
      expect(Array.isArray((err as CrossoverError).details?.["issues"])).toBe(true);
    }
    expect(await lastSeq(room)).toBe(0);
  });

  it("invalid params → VALIDATION with zod issues, and nothing runs", async () => {
    const room = await newRoom();
    const d = dispatcher();
    registerSay(d);
    const err = await d
      .dispatch(principal(room), envelope("messages.send", { body: "" }, nextKey()))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "VALIDATION" });
    const issues = (err as CrossoverError).details?.["issues"] as {
      path: unknown[];
      code: string;
    }[];
    expect(issues[0]).toMatchObject({ path: ["body"] });
    expect(await effects(room)).toEqual([]);
    expect(await lastSeq(room)).toBe(0);
    expect(await getLease(pool, room)).toBeNull(); // rejected before touching the room
  });

  it("params that aren't plain JSON → VALIDATION, not a TypeError", async () => {
    const room = await newRoom();
    const d = dispatcher();
    d.registerCommand({
      method: "messages.send",
      params: z.object({ at: z.date() }),
      mutating: true,
      execute: async () => ({ response: null }),
    });
    await expect(
      d.dispatch(principal(room), envelope("messages.send", { at: new Date() }, nextKey())),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("parsed params (defaults, coercion) are what execute receives", async () => {
    const room = await newRoom();
    const d = dispatcher();
    registerSay(d);
    const out = await d.dispatch(
      principal(room),
      envelope("messages.send", { body: "hi" }, nextKey()),
    );
    expect(out.events).toHaveLength(1); // n defaulted to 1
  });
});

describe("dispatch: mutating commands", () => {
  it("runs execute, appends its events with causation_id = envelope.id, and returns them", async () => {
    const room = await newRoom();
    const d = dispatcher();
    registerSay(d);
    const env = envelope("messages.send", { body: "hello", n: 2 }, nextKey());
    const out = await d.dispatch(principal(room, "part_7"), env);
    expect(out.response).toEqual({ said: "hello" });
    expect(out.replayed).toBe(false);
    expect(out.events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(out.events.every((e) => e.causation_id === env.id)).toBe(true);
    const rows = await eventRows(room);
    expect(rows.map((r) => [Number(r.sequence), r.type, r.actor_id, r.causation_id])).toEqual([
      [1, "message.sent", "part_7", env.id],
      [2, "message.sent", "part_7", env.id],
    ]);
    expect(await effects(room)).toEqual(["hello"]);
    expect(await lastSeq(room)).toBe(2);
  });

  it("lets a command emit system events with their own actor_id, but not override causation_id", async () => {
    const room = await newRoom();
    const d = dispatcher();
    d.registerCommand({
      method: "room.freeze",
      params: z.object({}),
      mutating: true,
      execute: async () => ({
        response: "ok",
        events: [
          // causation_id isn't part of EmittedEvent; a stray one must be ignored.
          { type: "room.paused", actor_id: "system", causation_id: "cmd_forged" } as EmittedEvent,
        ],
      }),
    });
    const env = envelope("room.freeze", {}, nextKey());
    const out = await d.dispatch(principal(room), env);
    expect(out.events[0]).toMatchObject({ actor_id: "system", causation_id: env.id });
  });

  it("a command with no events still commits its state and response", async () => {
    const room = await newRoom();
    const d = dispatcher();
    d.registerCommand({
      method: "inbox.ack",
      params: z.object({}),
      mutating: true,
      execute: async (ctx) => {
        await ctx.client.query("INSERT INTO side_effects (room_id, tag) VALUES ($1, 'acked')", [
          ctx.room_id,
        ]);
        return { response: { acked: true } };
      },
    });
    const out = await d.dispatch(principal(room), envelope("inbox.ack", {}, nextKey()));
    expect(out).toEqual({ response: { acked: true }, events: [], replayed: false });
    expect(await effects(room)).toEqual(["acked"]);
    expect(await lastSeq(room)).toBe(0);
  });

  it("if execute throws, no events or state persist and the error propagates", async () => {
    const room = await newRoom();
    const d = dispatcher();
    const boom = new Error("boom");
    d.registerCommand({
      method: "messages.send",
      params: z.object({}),
      mutating: true,
      execute: async (ctx): Promise<CommandResult<never>> => {
        await ctx.client.query("INSERT INTO side_effects (room_id, tag) VALUES ($1, 'half-done')", [
          ctx.room_id,
        ]);
        throw boom;
      },
    });
    const key = nextKey();
    await expect(d.dispatch(principal(room), envelope("messages.send", {}, key))).rejects.toBe(
      boom,
    );
    expect(await effects(room)).toEqual([]);
    expect(await eventRows(room)).toEqual([]);
    expect(await lastSeq(room)).toBe(0);
    expect(
      (await pool.query("SELECT 1 FROM idempotency_keys WHERE idempotency_key = $1", [key]))
        .rowCount,
    ).toBe(0);
  });

  it("if appending the events fails, execute's writes roll back too", async () => {
    const room = await newRoom();
    const d = dispatcher();
    d.registerCommand({
      method: "messages.send",
      params: z.object({}),
      mutating: true,
      execute: async (ctx) => {
        await ctx.client.query("INSERT INTO side_effects (room_id, tag) VALUES ($1, 'x')", [
          ctx.room_id,
        ]);
        // An event type outside the catalog fails ledger validation.
        return { response: 1, events: [{ type: "task.exploded" as never }] };
      },
    });
    await expect(
      d.dispatch(principal(room), envelope("messages.send", {}, nextKey())),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await effects(room)).toEqual([]);
    expect(await lastSeq(room)).toBe(0);
  });

  it("an unknown room → NOT_FOUND", async () => {
    const d = dispatcher();
    registerSay(d);
    await expect(
      d.dispatch(principal("room_missing"), envelope("messages.send", { body: "x" }, nextKey())),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("dispatch: idempotency", () => {
  it("a duplicate returns the original result without running execute again", async () => {
    const room = await newRoom();
    const d = dispatcher();
    registerSay(d);
    const key = nextKey();
    const first = await d.dispatch(
      principal(room),
      envelope("messages.send", { body: "once", n: 2 }, key),
    );
    const again = await d.dispatch(
      principal(room),
      envelope("messages.send", { body: "once", n: 2 }, key),
    );
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.response).toEqual(first.response);
    expect(again.events).toEqual(first.events); // the same events, not new ones
    expect(await effects(room)).toEqual(["once"]);
    expect(await lastSeq(room)).toBe(2);
  });

  it("the same key with different params → VALIDATION and nothing runs", async () => {
    const room = await newRoom();
    const d = dispatcher();
    registerSay(d);
    const key = nextKey();
    await d.dispatch(principal(room), envelope("messages.send", { body: "a" }, key));
    await expect(
      d.dispatch(principal(room), envelope("messages.send", { body: "b" }, key)),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await effects(room)).toEqual(["a"]);
  });

  it("the same key in a different room is a different request", async () => {
    const [a, b] = [await newRoom(), await newRoom()];
    const d = dispatcher();
    registerSay(d);
    const key = nextKey();
    await d.dispatch(principal(a), envelope("messages.send", { body: "x" }, key));
    await expect(
      d.dispatch(principal(b), envelope("messages.send", { body: "x" }, key)),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("concurrent duplicates: execute runs exactly once", async () => {
    const room = await newRoom();
    const d = dispatcher();
    let calls = 0;
    d.registerCommand({
      method: "messages.send",
      params: z.object({}),
      mutating: true,
      execute: async (ctx) => {
        calls++;
        await sleep(30);
        await ctx.client.query("INSERT INTO side_effects (room_id, tag) VALUES ($1, 'x')", [
          ctx.room_id,
        ]);
        return { response: { n: calls }, events: [{ type: "message.sent" as const }] };
      },
    });
    const key = nextKey();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        d.dispatch(principal(room), envelope("messages.send", {}, key)),
      ),
    );
    expect(calls).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => JSON.stringify(r.response))).size).toBe(1);
    expect(await effects(room)).toEqual(["x"]);
    expect(await lastSeq(room)).toBe(1);
  });
});

describe("dispatch: the room actor", () => {
  it("serializes commands for one room but runs different rooms concurrently", async () => {
    const [a, b] = [await newRoom(), await newRoom()];
    const d = dispatcher();
    const running = new Map<string, number>();
    let maxPerRoom = 0;
    let total = 0;
    let maxTotal = 0;
    d.registerCommand({
      method: "messages.send",
      params: z.object({}),
      mutating: true,
      execute: async (ctx) => {
        const mine = (running.get(ctx.room_id) ?? 0) + 1;
        running.set(ctx.room_id, mine);
        total++;
        maxPerRoom = Math.max(maxPerRoom, mine);
        maxTotal = Math.max(maxTotal, total);
        await sleep(20);
        running.set(ctx.room_id, mine - 1);
        total--;
        return { response: null, events: [{ type: "message.sent" as const }] };
      },
    });
    const all = [a, b].flatMap((room) =>
      Array.from({ length: 4 }, () =>
        d.dispatch(principal(room), envelope("messages.send", {}, nextKey())),
      ),
    );
    await Promise.all(all);
    expect(maxPerRoom).toBe(1);
    expect(maxTotal).toBe(2);
    expect(await lastSeq(a)).toBe(4);
    expect(await lastSeq(b)).toBe(4);
  });

  it("a failing command doesn't stop the room's queue", async () => {
    const room = await newRoom();
    const d = dispatcher();
    d.registerCommand({
      method: "messages.send",
      params: z.object({ fail: z.boolean() }),
      mutating: true,
      execute: async (_ctx, p) => {
        if (p.fail) throw new Error("nope");
        return { response: "ok", events: [{ type: "message.sent" as const }] };
      },
    });
    const results = await Promise.allSettled([
      d.dispatch(principal(room), envelope("messages.send", { fail: false }, nextKey())),
      d.dispatch(principal(room), envelope("messages.send", { fail: true }, nextKey())),
      d.dispatch(principal(room), envelope("messages.send", { fail: false }, nextKey())),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(await lastSeq(room)).toBe(2);
  });
});

describe("dispatch: leases and fencing", () => {
  it("acquires the room lease and writes with its token", async () => {
    const room = await newRoom();
    const d = dispatcher(allowAll, "node-lease");
    registerSay(d);
    await d.dispatch(principal(room), envelope("messages.send", { body: "x" }, nextKey()));
    expect(await getLease(pool, room)).toMatchObject({ node_id: "node-lease", fencing_token: 1 });
    expect(d.leases.heldRooms()).toEqual([room]);
    const first = (await getLease(pool, room))!.expires_at.getTime();
    await sleep(20);
    await d.dispatch(principal(room), envelope("messages.send", { body: "y" }, nextKey()));
    const lease = (await getLease(pool, room))!;
    expect(lease.fencing_token).toBe(1); // renewed, not re-acquired
    expect(lease.expires_at.getTime()).toBeGreaterThan(first); // and extended
  });

  it("a room owned by another node fails with STALE_FENCE and writes nothing", async () => {
    const room = await newRoom();
    await acquireLease(pool, room, "other-node", 60_000);
    const d = dispatcher();
    registerSay(d);
    await expect(
      d.dispatch(principal(room), envelope("messages.send", { body: "x" }, nextKey())),
    ).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect(await effects(room)).toEqual([]);
    expect(await lastSeq(room)).toBe(0);
  });

  it("after a takeover the old owner is fenced out, then re-acquires with a larger token when it's free", async () => {
    const room = await newRoom();
    const d = dispatcher(allowAll, "node-a");
    registerSay(d);
    await d.dispatch(principal(room), envelope("messages.send", { body: "1" }, nextKey()));
    // node-a's lease lapses and node-b takes the room over.
    await pool.query(
      "UPDATE room_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE room_id = $1",
      [room],
    );
    const b = await acquireLease(pool, room, "node-b", 60_000);
    expect(b!.fencing_token).toBe(2);

    await expect(
      d.dispatch(principal(room), envelope("messages.send", { body: "zombie" }, nextKey())),
    ).rejects.toMatchObject({ code: "STALE_FENCE" });
    expect(await effects(room)).toEqual(["1"]); // the zombie write didn't land

    // node-b goes away; node-a can come back with a strictly larger token.
    await pool.query(
      "UPDATE room_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE room_id = $1",
      [room],
    );
    await d.dispatch(principal(room), envelope("messages.send", { body: "2" }, nextKey()));
    expect((await getLease(pool, room))!.fencing_token).toBe(3);
    expect(await effects(room)).toEqual(["1", "2"]);
  });

  it("re-acquires after its own lease lapses with nobody else involved", async () => {
    const room = await newRoom();
    const d = dispatcher(allowAll, "node-solo");
    registerSay(d);
    await d.dispatch(principal(room), envelope("messages.send", { body: "1" }, nextKey()));
    await pool.query(
      "UPDATE room_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE room_id = $1",
      [room],
    );
    await d.dispatch(principal(room), envelope("messages.send", { body: "2" }, nextKey()));
    expect((await getLease(pool, room))!.fencing_token).toBe(2);
    expect(await lastSeq(room)).toBe(2);
  });

  it("releaseAll gives up the leases so another node can take over at once", async () => {
    const room = await newRoom();
    const d = dispatcher(allowAll, "node-shutdown");
    registerSay(d);
    await d.dispatch(principal(room), envelope("messages.send", { body: "x" }, nextKey()));
    await d.leases.releaseAll();
    expect(d.leases.heldRooms()).toEqual([]);
    expect(await acquireLease(pool, room, "node-next")).toMatchObject({ fencing_token: 2 });
  });
});

describe("dispatch: authorization", () => {
  it("calls the authorizer with the principal, action, resource and context", async () => {
    const room = await newRoom();
    const calls: unknown[][] = [];
    const d = dispatcher(async (p, action, resource, ctx) => {
      calls.push([p, action, resource, ctx.method, ctx.params]);
    });
    registerSay(d);
    await d.dispatch(
      principal(room, "part_9"),
      envelope("messages.send", { body: "hi" }, nextKey()),
    );
    expect(calls).toEqual([
      [
        {
          participant_id: "part_9",
          room_id: room,
          kind: "HUMAN",
          authority: "MEMBER",
          role: "DEVELOPER",
        },
        "messages.send",
        { room_id: room },
        "messages.send",
        { body: "hi", n: 1 },
      ],
    ]);
  });

  it("uses the command's declared action when it has one", async () => {
    const room = await newRoom();
    const actions: string[] = [];
    const d = dispatcher(async (_p, action) => void actions.push(action));
    d.registerCommand({
      method: "messages.send",
      action: "messages.write",
      params: z.object({}),
      mutating: true,
      execute: async () => ({ response: null }),
    });
    await d.dispatch(principal(room), envelope("messages.send", {}, nextKey()));
    expect(actions).toEqual(["messages.write"]);
  });

  it("FORBIDDEN from the authorizer propagates; execute doesn't run, nothing persists", async () => {
    const room = await newRoom();
    const d = dispatcher(async (_p, action) => {
      throw new CrossoverError("FORBIDDEN", "no", { details: { missing_capability: action } });
    });
    registerSay(d);
    const key = nextKey();
    await expect(
      d.dispatch(principal(room), envelope("messages.send", { body: "x" }, key)),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { missing_capability: "messages.send" },
    });
    expect(await effects(room)).toEqual([]);
    // The only trace is the denial itself (T215), in a transaction of its own.
    expect((await eventRows(room)).map((e) => e.type)).toEqual(["capability.denied"]);
    expect(
      (await pool.query("SELECT 1 FROM idempotency_keys WHERE idempotency_key = $1", [key]))
        .rowCount,
    ).toBe(0);
  });

  it("authorization runs before the idempotency lookup, so a replay can't bypass it", async () => {
    const room = await newRoom();
    let allowed = true;
    const d = dispatcher(async () => {
      if (!allowed) throw new CrossoverError("FORBIDDEN", "revoked");
    });
    registerSay(d);
    const env = envelope("messages.send", { body: "x" }, nextKey());
    await d.dispatch(principal(room), env);
    allowed = false;
    await expect(d.dispatch(principal(room), env)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("the authorizer gets the transaction client: its writes roll back when it denies", async () => {
    const room = await newRoom();
    const d = dispatcher(async (_p, _a, resource, ctx) => {
      await ctx.client.query(
        "INSERT INTO side_effects (room_id, tag) VALUES ($1, 'from-authorizer')",
        [resource.room_id],
      );
      throw new CrossoverError("FORBIDDEN", "no");
    });
    registerSay(d);
    await expect(
      d.dispatch(principal(room), envelope("messages.send", { body: "x" }, nextKey())),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await effects(room)).toEqual([]); // rolled back with the transaction
  });
});

describe("dispatch: ctx.idempotency_key", () => {
  it("gives mutating commands the envelope's key, and reads undefined", async () => {
    const room = await newRoom();
    const d = dispatcher();
    const seen: (string | undefined)[] = [];
    d.registerCommand({
      method: "messages.send",
      params: z.object({}),
      mutating: true,
      execute: async (ctx) => {
        seen.push(ctx.idempotency_key);
        return { response: null };
      },
    });
    d.registerCommand({
      method: "room.get_state",
      params: z.object({}),
      mutating: false,
      execute: async (ctx) => {
        seen.push(ctx.idempotency_key);
        return { response: null };
      },
    });
    await d.dispatch(principal(room), envelope("messages.send", {}, "my-key-1"));
    await d.dispatch(principal(room), envelope("room.get_state"));
    expect(seen).toEqual(["my-key-1", undefined]);
  });
});

describe("dispatch: ctx.authorize (finer-grained checks)", () => {
  it("re-runs the policy for a resource, with room_id filled in and the same transaction", async () => {
    const room = await newRoom();
    const seen: unknown[] = [];
    const d = dispatcher(async (_p, action, resource) => {
      seen.push([action, resource]);
    });
    d.registerCommand({
      method: "workspace.apply_changeset",
      params: z.object({ paths: z.array(z.string()) }),
      mutating: true,
      execute: async (ctx, p) => {
        for (const path of p.paths) await ctx.authorize("workspace.write", { path });
        return { response: p.paths.length };
      },
    });
    await d.dispatch(
      principal(room),
      envelope("workspace.apply_changeset", { paths: ["a.txt", "docs/b.md"] }, nextKey()),
    );
    expect(seen).toEqual([
      ["workspace.apply_changeset", { room_id: room }],
      ["workspace.write", { path: "a.txt", room_id: room }],
      ["workspace.write", { path: "docs/b.md", room_id: room }],
    ]);
  });

  it("a denied path fails the whole command and rolls everything back", async () => {
    const room = await newRoom();
    const d = dispatcher(async (_p, action, resource) => {
      if (action === "workspace.write" && resource["path"] === "secrets/key") {
        throw new CrossoverError("FORBIDDEN", "no", { details: { path: resource["path"] } });
      }
    });
    d.registerCommand({
      method: "workspace.apply_changeset",
      params: z.object({ paths: z.array(z.string()) }),
      mutating: true,
      execute: async (ctx, p) => {
        for (const path of p.paths) {
          await ctx.client.query("INSERT INTO side_effects (room_id, tag) VALUES ($1, $2)", [
            ctx.room_id,
            path,
          ]);
          await ctx.authorize("workspace.write", { path });
        }
        return { response: null, events: [{ type: "workspace.changeset.applied" as const }] };
      },
    });
    await expect(
      d.dispatch(
        principal(room),
        envelope("workspace.apply_changeset", { paths: ["ok.txt", "secrets/key"] }, nextKey()),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", details: { path: "secrets/key" } });
    expect(await effects(room)).toEqual([]);
    const rows = await eventRows(room);
    expect(rows.map((e) => e.type)).toEqual(["capability.denied"]); // not changeset.applied
    expect(rows[0].payload).toMatchObject({
      action: "workspace.write",
      resource: { path: "secrets/key" },
    });
  });

  it("is available to reads too", async () => {
    const room = await newRoom();
    const actions: string[] = [];
    const d = dispatcher(async (_p, action) => void actions.push(action));
    d.registerCommand({
      method: "workspace.read",
      params: z.object({}),
      mutating: false,
      execute: async (ctx) => {
        await ctx.authorize("workspace.read.path", { path: "x" });
        return { response: 1 };
      },
    });
    await d.dispatch(principal(room), envelope("workspace.read"));
    expect(actions).toEqual(["workspace.read", "workspace.read.path"]);
  });
});

describe("dispatch: afterCommit", () => {
  const register = (
    d: Dispatcher,
    execute: Parameters<Dispatcher["registerCommand"]>[0]["execute"],
  ) =>
    d.registerCommand({ method: "messages.send", params: z.object({}), mutating: true, execute });

  it("runs after the commit: the data is visible from another connection", async () => {
    const room = await newRoom();
    const d = dispatcher();
    let seenFromOutside: string[] = [];
    register(d, async (ctx) => {
      await ctx.client.query("INSERT INTO side_effects (room_id, tag) VALUES ($1, 'row')", [
        ctx.room_id,
      ]);
      ctx.afterCommit(async () => {
        // A different connection (the pool) only sees committed data.
        seenFromOutside = await effects(room);
      });
      return { response: null, events: [{ type: "message.sent" as const }] };
    });
    await d.dispatch(principal(room), envelope("messages.send", {}, nextKey()));
    expect(seenFromOutside).toEqual(["row"]);
  });

  it("runs on the room's actor, before the next command for the room starts", async () => {
    const room = await newRoom();
    const d = dispatcher();
    const log: string[] = [];
    register(d, async (ctx) => {
      log.push(`execute-${ctx.command_id.slice(-4)}`);
      ctx.afterCommit(async () => {
        await sleep(30);
        log.push("after-commit");
      });
      return { response: null };
    });
    const [first, second] = [
      d.dispatch(principal(room), envelope("messages.send", {}, nextKey())),
      d.dispatch(principal(room), envelope("messages.send", {}, nextKey())),
    ];
    await Promise.all([first, second]);
    expect(log.map((l) => l.replace(/-.*/, ""))).toEqual(["execute", "after", "execute", "after"]);
  });

  it("also accepts the hook as CommandResult.afterCommit, after ctx-registered callbacks", async () => {
    const room = await newRoom();
    const d = dispatcher();
    const log: string[] = [];
    register(d, async (ctx) => {
      ctx.afterCommit(() => void log.push("ctx"));
      return { response: null, afterCommit: async () => void log.push("result") };
    });
    await d.dispatch(principal(room), envelope("messages.send", {}, nextKey()));
    expect(log).toEqual(["ctx", "result"]);
  });

  it("runs callbacks in registration order and awaits each", async () => {
    const room = await newRoom();
    const d = dispatcher();
    const log: number[] = [];
    register(d, async (ctx) => {
      ctx.afterCommit(async () => {
        await sleep(20);
        log.push(1);
      });
      ctx.afterCommit(() => void log.push(2));
      return { response: null };
    });
    await d.dispatch(principal(room), envelope("messages.send", {}, nextKey()));
    expect(log).toEqual([1, 2]);
  });

  it("doesn't run if the command fails, rolls back, or is denied", async () => {
    let ran = 0;
    const tracked = (
      d: Dispatcher,
      execute: Parameters<Dispatcher["registerCommand"]>[0]["execute"],
    ) =>
      register(d, async (ctx, params) => {
        ctx.afterCommit(() => void ran++);
        return execute(ctx, params);
      });

    // Each case gets its own room: a dispatcher owns the rooms it has written to.
    const failing = dispatcher();
    tracked(failing, async () => {
      throw new Error("boom");
    });
    await expect(
      failing.dispatch(principal(await newRoom()), envelope("messages.send", {}, nextKey())),
    ).rejects.toThrow("boom");

    const badEvents = dispatcher();
    tracked(badEvents, async () => ({ response: 1, events: [{ type: "task.exploded" as never }] }));
    await expect(
      badEvents.dispatch(principal(await newRoom()), envelope("messages.send", {}, nextKey())),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const denying = dispatcher(async (_p, action) => {
      if (action === "x") throw new CrossoverError("FORBIDDEN", "no");
    });
    tracked(denying, async (ctx) => {
      await ctx.authorize("x");
      return { response: 1 };
    });
    await expect(
      denying.dispatch(principal(await newRoom()), envelope("messages.send", {}, nextKey())),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(ran).toBe(0);
  });

  it("doesn't run again when an idempotent duplicate is replayed", async () => {
    const room = await newRoom();
    const d = dispatcher();
    let ran = 0;
    register(d, async (ctx) => {
      ctx.afterCommit(() => void ran++);
      return { response: null };
    });
    const env = envelope("messages.send", {}, nextKey());
    await d.dispatch(principal(room), env);
    const again = await d.dispatch(principal(room), env);
    expect(again.replayed).toBe(true);
    expect(ran).toBe(1);
  });

  it("a callback that throws is reported but the command still succeeds and stays committed", async () => {
    const room = await newRoom();
    const reported: { error: unknown; method: string; command_id: string; room_id: string }[] = [];
    const d = dispatcher(allowAll, undefined, {
      onAfterCommitError: (error, info) => void reported.push({ error, ...info }),
    });
    const boom = new Error("ref update failed");
    let secondRan = false;
    register(d, async (ctx) => {
      await ctx.client.query("INSERT INTO side_effects (room_id, tag) VALUES ($1, 'kept')", [
        ctx.room_id,
      ]);
      ctx.afterCommit(() => {
        throw boom;
      });
      ctx.afterCommit(() => void (secondRan = true)); // later callbacks still run
      return { response: "done", events: [{ type: "message.sent" as const }] };
    });
    const env = envelope("messages.send", {}, nextKey());
    const out = await d.dispatch(principal(room), env);
    expect(out).toMatchObject({ response: "done", replayed: false });
    expect(reported).toEqual([
      { error: boom, method: "messages.send", command_id: env.id, room_id: room },
    ]);
    expect(secondRan).toBe(true);
    expect(await effects(room)).toEqual(["kept"]);
    expect(await lastSeq(room)).toBe(1);
    // ...and the next command for the room isn't blocked.
    const next = envelope("messages.send", {}, nextKey());
    await expect(d.dispatch(principal(room), next)).resolves.toMatchObject({ response: "done" });
  });

  it("is rejected for read-only commands", async () => {
    const room = await newRoom();
    const d = dispatcher();
    d.registerCommand({
      method: "room.get_state",
      params: z.object({}),
      mutating: false,
      execute: async (ctx) => {
        ctx.afterCommit(() => {});
        return { response: 1 };
      },
    });
    await expect(d.dispatch(principal(room), envelope("room.get_state"))).rejects.toThrow(
      /afterCommit needs a transaction/,
    );
  });
});

describe("dispatch: reads", () => {
  it("run execute and return its response without a lease, a transaction, or events", async () => {
    const room = await newRoom();
    const d = dispatcher();
    d.registerCommand({
      method: "room.get_state",
      params: z.object({}),
      mutating: false,
      execute: async (ctx: { client: PoolClient; room_id: string }) => {
        const { rows } = await ctx.client.query("SELECT last_sequence FROM rooms WHERE id = $1", [
          ctx.room_id,
        ]);
        return { response: { last_sequence: Number(rows[0].last_sequence) } };
      },
    });
    const out = await d.dispatch(principal(room), envelope("room.get_state"));
    expect(out).toEqual({ response: { last_sequence: 0 }, events: [], replayed: false });
    expect(await getLease(pool, room)).toBeNull();
    expect(d.actors.size).toBe(0);
  });

  it("still authorize, and a read that emits events is an error", async () => {
    const room = await newRoom();
    const denied = dispatcher(async () => {
      throw new CrossoverError("FORBIDDEN", "no");
    });
    denied.registerCommand({
      method: "room.get_state",
      params: z.object({}),
      mutating: false,
      execute: async () => ({ response: 1 }),
    });
    await expect(
      denied.dispatch(principal(room), envelope("room.get_state")),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const d = dispatcher();
    d.registerCommand({
      method: "room.digest",
      params: z.object({}),
      mutating: false,
      execute: async () => ({ response: 1, events: [{ type: "message.sent" as const }] }),
    });
    await expect(d.dispatch(principal(room), envelope("room.digest"))).rejects.toThrow(/read-only/);
    expect((await eventRows(room)).map((e) => e.type)).toEqual(["capability.denied"]); // only the denied read above
  });

  it("a read doesn't need an idempotency key, and doesn't leak its connection", async () => {
    const room = await newRoom();
    const d = dispatcher();
    d.registerCommand({
      method: "room.get_state",
      params: z.object({}),
      mutating: false,
      execute: async () => ({ response: "ok" }),
    });
    for (let i = 0; i < 30; i++) await d.dispatch(principal(room), envelope("room.get_state"));
    expect(pool.totalCount - pool.idleCount).toBe(0); // every client went back to the pool
  });
});

describe("registerCommand", () => {
  it("rejects methods outside the §16.1 catalog", () => {
    expect(() =>
      dispatcher().registerCommand({
        method: "tasks.exploded",
        params: z.object({}),
        mutating: true,
        execute: async () => ({ response: null }),
      }),
    ).toThrow(/not a method in the §16.1 catalog/);
  });

  it("rejects a mutating flag that disagrees with the catalog", () => {
    expect(() =>
      dispatcher().registerCommand({
        method: "tasks.claim",
        params: z.object({}),
        mutating: false,
        execute: async () => ({ response: null }),
      }),
    ).toThrow(/mutating/);
    expect(() =>
      dispatcher().registerCommand({
        method: "tasks.list",
        params: z.object({}),
        mutating: true,
        execute: async () => ({ response: null }),
      }),
    ).toThrow(/read-only/);
  });

  it("rejects registering a method twice", () => {
    const d = dispatcher();
    registerSay(d);
    expect(() => registerSay(d)).toThrow(/already registered/);
  });
});

describe("dispatch: load", () => {
  it("many concurrent commands on one pool don't exhaust connections", async () => {
    const room = await newRoom();
    const d = dispatcher();
    registerSay(d);
    await Promise.all([
      ...Array.from({ length: 15 }, (_, i) =>
        d.dispatch(principal(room), envelope("messages.send", { body: `m${i}` }, nextKey())),
      ),
      withTransaction(pool, async (c) => c.query("SELECT 1")),
    ]);
    expect(await lastSeq(room)).toBe(15);
  });
});
