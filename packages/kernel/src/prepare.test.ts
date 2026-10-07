import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Dispatcher, type PrepareContext } from "./dispatcher.js";
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

const envelope = (method: string, params: Record<string, unknown> = {}, key = `k-${++n}`) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: key,
});

async function setup() {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerMessageCommands(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  const add = async (role: string, authority = "MEMBER"): Promise<Principal> => {
    const id = newId("part");
    await pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, 'AGENT', $1, $3, $4, 'ACTIVE')`,
      [id, room, authority, role],
    );
    return { participant_id: id, room_id: room, kind: "AGENT", authority, role } as Principal;
  };
  const log: string[] = [];
  let release: (() => void) | undefined;
  let gate: Promise<void> = Promise.resolve();
  let onPrepare: (() => void) | undefined;
  d.registerCommand({
    method: "memory.put", // any mutating method in the catalog; the test gives it its own behaviour
    action: "memory.write",
    mutating: true,
    params: z.strictObject({ key: z.string(), value: z.string(), expected_revision: z.number() }),
    prepare: async (ctx: PrepareContext, p) => {
      log.push("prepare");
      onPrepare?.();
      await gate;
      return { slow: `prepared ${p.key}`, command: ctx.command_id };
    },
    disposePrepared: async () => {
      log.push("dispose");
    },
    execute: async (ctx, p) => {
      log.push("execute");
      if (p.value === "boom") throw new CrossoverError("VALIDATION", "boom");
      return { response: { prepared: ctx.prepared } };
    },
  });
  return {
    d,
    room,
    log,
    dev: await add("DEVELOPER"),
    observer: await add("OBSERVER"),
    slow: () => {
      gate = new Promise<void>((resolve) => (release = resolve));
      return {
        started: new Promise<void>((resolve) => (onPrepare = resolve)),
        release: () => release!(),
      };
    },
  };
}

describe("a command's prepare phase (T807)", () => {
  it("runs before execute and hands its result over; disposal follows, success or failure", async () => {
    const s = await setup();
    const ok = await s.d.dispatch(
      s.dev,
      envelope("memory.put", { key: "a", value: "v", expected_revision: 0 }),
    );
    expect(ok.response).toMatchObject({ prepared: { slow: "prepared a" } });
    expect(s.log).toEqual(["prepare", "execute", "dispose"]);
    s.log.length = 0;
    await expect(
      s.d.dispatch(
        s.dev,
        envelope("memory.put", { key: "a", value: "boom", expected_revision: 0 }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(s.log).toEqual(["prepare", "execute", "dispose"]);
  });

  it("isn't run for someone who may not run the command, nor for a replay of one that ran", async () => {
    const s = await setup();
    await expect(
      s.d.dispatch(
        s.observer,
        envelope("memory.put", { key: "a", value: "v", expected_revision: 0 }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(s.log).toEqual([]); // nothing slow was done for someone refused

    const request = envelope("memory.put", { key: "b", value: "v", expected_revision: 0 });
    await s.d.dispatch(s.dev, request);
    s.log.length = 0;
    const replay = await s.d.dispatch(s.dev, request);
    expect(replay.replayed).toBe(true);
    expect(s.log).toEqual([]);
  });

  it("doesn't hold the room: another command goes through while prepare is still running", async () => {
    const s = await setup();
    const slow = s.slow();
    const running = s.d.dispatch(
      s.dev,
      envelope("memory.put", { key: "c", value: "v", expected_revision: 0 }),
    );
    await slow.started;
    const sent = await Promise.race([
      s.d.dispatch(s.dev, envelope("messages.send", { body: "meanwhile" })).then(() => "sent"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
    ]);
    expect(sent).toBe("sent");
    expect(s.log).toEqual(["prepare"]); // execute hasn't started
    slow.release();
    await running;
    expect(s.log).toEqual(["prepare", "execute", "dispose"]);
  });

  it("a failure to check the principal (not a refusal) is a retryable error, not an internal one", async () => {
    let down = false;
    const d = new Dispatcher({
      pool,
      nodeId: `node-${++n}`,
      authorize: async (...args) => {
        if (down) throw new Error("the database is unreachable");
        return authorize(...args);
      },
    });
    d.registerCommand({
      method: "memory.put",
      action: "memory.write",
      mutating: true,
      params: z.strictObject({ key: z.string(), value: z.string(), expected_revision: z.number() }),
      prepare: async () => "slow",
      execute: async () => ({ response: {} }),
    });
    const room = newId("room");
    await pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
      [room],
    );
    const id = newId("part");
    await pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, 'AGENT', $1, 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
      [id, room],
    );
    const dev = {
      participant_id: id,
      room_id: room,
      kind: "AGENT",
      authority: "MEMBER",
      role: "DEVELOPER",
    } as Principal;
    down = true;
    const err = await d
      .dispatch(dev, envelope("memory.put", { key: "a", value: "v", expected_revision: 0 }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossoverError);
    expect((err as CrossoverError).retryable).toBe(true);
    expect((err as CrossoverError).details).toMatchObject({ reason: "prepare_unavailable" });
  });
});
