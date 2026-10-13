import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { allowAll, Dispatcher, type Authorizer } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerInviteCommands, type RoomInviteSecret } from "../invites/invite.js";
import { registerJoinCommand } from "../invites/join.js";
import {
  registerRoomLifecycleCommands,
  ROOM_TRANSITIONS,
  type LifecycleCommand,
  type RoomLifecycleOptions,
  type RoomStatus,
} from "./lifecycle.js";
import { registerRoomRetentionCommands } from "./retention.js";

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

async function add(
  room: string,
  kind: "HUMAN" | "AGENT",
  authority: "OWNER" | "ADMIN" | "MEMBER",
  role: Principal["role"],
): Promise<Principal> {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, $3, $1, $4, $5, 'ACTIVE')`,
    [id, room, kind, authority, role],
  );
  return { participant_id: id, room_id: room, kind, authority, role };
}

async function setup(
  status: RoomStatus = "ACTIVE",
  options: {
    authorizer?: Authorizer;
    lifecycle?: RoomLifecycleOptions;
    onAfterCommitError?: (e: unknown) => void;
  } = {},
) {
  const d = new Dispatcher({
    pool,
    authorize: options.authorizer ?? authorize,
    nodeId: `node-${++n}`,
    ...(options.onAfterCommitError ? { onAfterCommitError: options.onAfterCommitError } : {}),
  });
  registerRoomLifecycleCommands(d, options.lifecycle);
  registerRoomRetentionCommands(d);
  registerInviteCommands(d);
  registerJoinCommand(d);
  d.registerCommand({
    method: "tasks.create",
    mutating: true,
    params: z.object({}),
    execute: async () => ({ response: { ok: true } }),
  });
  d.registerCommand({
    method: "tasks.list",
    action: "tasks.read",
    mutating: false,
    view: "none",
    view_reason: "test fixture",
    params: z.object({}),
    execute: async () => ({ response: { tasks: [] } }),
  });
  const room = newId("room");
  const ownerId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id, status) VALUES ($1, $1, 'n', 'o', $2, $3)`,
    [room, ownerId, status],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'owner', 'OWNER', 'DEVELOPER', 'ACTIVE')`,
    [ownerId, room],
  );
  const owner: Principal = {
    participant_id: ownerId,
    room_id: room,
    kind: "HUMAN",
    authority: "OWNER",
    role: "DEVELOPER",
  };
  return {
    d,
    room,
    owner,
    admin: await add(room, "HUMAN", "ADMIN", "DEVELOPER"),
    lead: await add(room, "AGENT", "MEMBER", "LEAD"),
    agent: await add(room, "AGENT", "MEMBER", "DEVELOPER"),
    human: await add(room, "HUMAN", "MEMBER", "DEVELOPER"),
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const run = (s: Setup, who: Principal, method: string, params: Record<string, unknown> = {}) =>
  s.d.dispatch(who, cmd(method, params));
const statusOf = async (room: string) =>
  (await pool.query("SELECT status FROM rooms WHERE id = $1", [room])).rows[0].status;

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

const COMMANDS = Object.keys(ROOM_TRANSITIONS) as LifecycleCommand[];
const STATES: RoomStatus[] = ["ACTIVE", "PAUSED", "ARCHIVED", "DELETED"];

describe("the state-transition table", () => {
  // What the commands themselves decide (no policy in the way).
  const commandLevel: Record<RoomStatus, Record<LifecycleCommand, RoomStatus | "VALIDATION">> = {
    ACTIVE: { "room.freeze": "PAUSED", "room.resume": "VALIDATION", "room.archive": "ARCHIVED" },
    PAUSED: { "room.freeze": "VALIDATION", "room.resume": "ACTIVE", "room.archive": "ARCHIVED" },
    ARCHIVED: {
      "room.freeze": "VALIDATION",
      "room.resume": "VALIDATION",
      "room.archive": "VALIDATION",
    },
    DELETED: {
      "room.freeze": "VALIDATION",
      "room.resume": "VALIDATION",
      "room.archive": "VALIDATION",
    },
  };

  for (const from of STATES) {
    for (const command of COMMANDS) {
      const expected = commandLevel[from][command];
      it(`${command} on a ${from} room → ${expected}`, async () => {
        const s = await setup(from, { authorizer: allowAll });
        if (expected === "VALIDATION") {
          const err = await rejects(run(s, s.owner, command), "VALIDATION");
          expect(err.details).toMatchObject({ room_status: from });
          expect(await statusOf(s.room)).toBe(from);
        } else {
          const out = await run(s, s.owner, command);
          expect(out.response).toEqual({
            room_id: s.room,
            status: expected,
            previous_status: from,
          });
          expect(await statusOf(s.room)).toBe(expected);
        }
      });
    }
  }

  it("with the real policy, an ARCHIVED room refuses even the owner's lifecycle commands, and a DELETED one is gone", async () => {
    for (const command of COMMANDS) {
      const archived = await setup("ARCHIVED");
      const err = await rejects(run(archived, archived.owner, command), "ROOM_PAUSED");
      expect(err.details).toMatchObject({ room_status: "ARCHIVED" });
      const deleted = await setup("DELETED");
      await rejects(run(deleted, deleted.owner, command), "NOT_FOUND");
    }
  });

  it("the transitions are exactly freeze, resume and archive as in §5", () => {
    expect(ROOM_TRANSITIONS).toEqual({
      "room.freeze": { from: ["ACTIVE"], to: "PAUSED" },
      "room.resume": { from: ["PAUSED"], to: "ACTIVE" },
      "room.archive": { from: ["ACTIVE", "PAUSED"], to: "ARCHIVED" },
    });
  });
});

describe("room.freeze / room.resume / room.archive", () => {
  it("are owner-only", async () => {
    const s = await setup();
    for (const who of [s.admin, s.lead, s.agent, s.human]) {
      for (const command of COMMANDS) await rejects(run(s, who, command), "FORBIDDEN");
    }
    expect(await statusOf(s.room)).toBe("ACTIVE");
  });

  it("emit room.paused, room.resumed and room.archived, and archive stamps archived_at", async () => {
    const s = await setup();
    const frozen = await run(s, s.owner, "room.freeze");
    expect(frozen.events[0]).toMatchObject({
      type: "room.paused",
      actor_id: s.owner.participant_id,
      payload: { previous_status: "ACTIVE", status: "PAUSED", changed_by: s.owner.participant_id },
    });
    const resumed = await run(s, s.owner, "room.resume");
    expect(resumed.events[0]).toMatchObject({
      type: "room.resumed",
      payload: { status: "ACTIVE" },
    });
    const before = await pool.query("SELECT archived_at FROM rooms WHERE id = $1", [s.room]);
    expect(before.rows[0].archived_at).toBeNull();
    const archived = await run(s, s.owner, "room.archive");
    expect(archived.events[0]).toMatchObject({
      type: "room.archived",
      payload: { previous_status: "ACTIVE", status: "ARCHIVED" },
    });
    const after = await pool.query("SELECT archived_at FROM rooms WHERE id = $1", [s.room]);
    expect(after.rows[0].archived_at).toBeInstanceOf(Date);
  });

  it("can archive a frozen room", async () => {
    const s = await setup();
    await run(s, s.owner, "room.freeze");
    await run(s, s.owner, "room.archive");
    expect(await statusOf(s.room)).toBe("ARCHIVED");
  });

  it("are idempotent per key", async () => {
    const s = await setup();
    const envelope = cmd("room.freeze");
    const a = await s.d.dispatch(s.owner, envelope);
    const b = await s.d.dispatch(s.owner, envelope);
    expect(b.replayed).toBe(true);
    expect(b.response).toEqual(a.response);
    const { rows } = await pool.query(
      "SELECT 1 FROM events WHERE room_id = $1 AND type = 'room.paused'",
      [s.room],
    );
    expect(rows).toHaveLength(1);
  });

  it("run afterChange after the commit; a failing hook doesn't undo the change", async () => {
    const seen: unknown[] = [];
    const errors: unknown[] = [];
    const s = await setup("ACTIVE", {
      lifecycle: {
        afterChange: async (info) => {
          seen.push(info);
          if (info.to === "ARCHIVED") throw new Error("sandbox cleanup failed");
        },
      },
      onAfterCommitError: (e) => errors.push(e),
    });
    await run(s, s.owner, "room.freeze");
    await run(s, s.owner, "room.archive");
    expect(seen).toEqual([
      { room_id: s.room, from: "ACTIVE", to: "PAUSED", changed_by: s.owner.participant_id },
      { room_id: s.room, from: "PAUSED", to: "ARCHIVED", changed_by: s.owner.participant_id },
    ]);
    expect(errors).toHaveLength(1);
    expect(await statusOf(s.room)).toBe("ARCHIVED");
  });
});

describe("rooms.set_retention / rooms.unarchive", () => {
  it("lets only the owner set a valid retention period and emits the change event", async () => {
    const s = await setup();
    const out = await run(s, s.owner, "rooms.set_retention", { retention_days: 30 });
    expect(out.response).toEqual({ room_id: s.room, retention_days: 30, changed: true });
    expect(out.events).toMatchObject([
      { type: "room.retention_changed", payload: { retention_days: 30 } },
    ]);
    await rejects(run(s, s.admin, "rooms.set_retention", { retention_days: 90 }), "FORBIDDEN");
    await rejects(run(s, s.owner, "rooms.set_retention", { retention_days: 29 }), "VALIDATION");
    expect(
      (await pool.query("SELECT retention_days FROM rooms WHERE id = $1", [s.room])).rows[0],
    ).toEqual({ retention_days: 30 });
  });

  it("allows the owner to extend an archived deadline and clears a previous notice", async () => {
    const s = await setup();
    await run(s, s.owner, "room.archive");
    await pool.query(
      "UPDATE rooms SET retention_notice_sent_at = clock_timestamp() WHERE id = $1",
      [s.room],
    );
    const out = await run(s, s.owner, "rooms.set_retention", { retention_days: 180 });
    expect(out.response).toMatchObject({ retention_days: 180, changed: true });
    const { rows } = await pool.query(
      "SELECT retention_days, retention_notice_sent_at FROM rooms WHERE id = $1",
      [s.room],
    );
    expect(rows[0]).toEqual({ retention_days: 180, retention_notice_sent_at: null });
  });

  it("refuses an archived deadline inside seven days", async () => {
    const s = await setup();
    await run(s, s.owner, "room.archive");
    await pool.query(
      "UPDATE rooms SET archived_at = clock_timestamp() - interval '24 days' WHERE id = $1",
      [s.room],
    );
    const err = await rejects(
      run(s, s.owner, "rooms.set_retention", { retention_days: 30 }),
      "VALIDATION",
    );
    expect(err.message).toBe("retention would end within the 7-day notice period");
  });

  it("unarchives only before expiry, clears the retention clock and does not create sandboxes", async () => {
    const s = await setup("ARCHIVED");
    await pool.query("UPDATE rooms SET archived_at = clock_timestamp() WHERE id = $1", [s.room]);
    const out = await run(s, s.owner, "rooms.unarchive");
    expect(out.response).toEqual({
      room_id: s.room,
      status: "ACTIVE",
      previous_status: "ARCHIVED",
    });
    expect(out.events).toMatchObject([{ type: "room.unarchived" }]);
    expect(await statusOf(s.room)).toBe("ACTIVE");
    expect(
      (await pool.query("SELECT archived_at FROM rooms WHERE id = $1", [s.room])).rows[0]
        .archived_at,
    ).toBeNull();
    expect(
      (await pool.query("SELECT id FROM sandboxes WHERE room_id = $1", [s.room])).rows,
    ).toEqual([]);
  });

  it("refuses unarchive after the stored deadline", async () => {
    const s = await setup("ARCHIVED");
    await pool.query(
      "UPDATE rooms SET archived_at = clock_timestamp() - interval '366 days' WHERE id = $1",
      [s.room],
    );
    await rejects(run(s, s.owner, "rooms.unarchive"), "VALIDATION");
    expect(await statusOf(s.room)).toBe("ARCHIVED");
  });

  it("refuses retention changes and unarchive once purge has started", async () => {
    const s = await setup("ARCHIVED");
    await pool.query(
      `UPDATE rooms SET archived_at = clock_timestamp() - interval '31 days',
                        retention_days = 30, purge_started_at = clock_timestamp(),
                        purge_phase = 'WORKSPACE'
        WHERE id = $1`,
      [s.room],
    );
    const retentionError = await rejects(
      run(s, s.owner, "rooms.set_retention", { retention_days: 180 }),
      "CONFLICT_VERSION",
    );
    const unarchiveError = await rejects(run(s, s.owner, "rooms.unarchive"), "CONFLICT_VERSION");
    expect(retentionError.message).toBe("room deletion is in progress");
    expect(unarchiveError.message).toBe("room deletion is in progress");
  });
});

describe("what a room's state allows, end to end", () => {
  it("a frozen room: agent and human mutations are ROOM_PAUSED, reads work, the owner can still act", async () => {
    const s = await setup();
    await run(s, s.agent, "tasks.create"); // fine while active
    await run(s, s.owner, "room.freeze");
    for (const who of [s.agent, s.lead, s.admin, s.human]) {
      const err = await rejects(run(s, who, "tasks.create"), "ROOM_PAUSED");
      expect(err.details).toMatchObject({ room_status: "PAUSED" });
      await run(s, who, "tasks.list"); // reads still work
    }
    await run(s, s.owner, "tasks.create");
    await run(s, s.owner, "room.invite", { role: "DEVELOPER" }); // the owner can still administer
    await run(s, s.owner, "room.resume");
    await run(s, s.agent, "tasks.create");
    await run(s, s.admin, "tasks.create");
  });

  it("an archived room is read-only for everyone", async () => {
    const s = await setup();
    await run(s, s.owner, "room.archive");
    for (const who of [s.owner, s.admin, s.lead, s.agent, s.human]) {
      const err = await rejects(run(s, who, "tasks.create"), "ROOM_PAUSED");
      expect(err.details).toMatchObject({ room_status: "ARCHIVED" });
      await run(s, who, "tasks.list");
    }
    await rejects(run(s, s.owner, "room.invite", { role: "DEVELOPER" }), "ROOM_PAUSED");
  });

  it("joining by invite is refused in a frozen or archived room, leaving the invite unspent", async () => {
    const s = await setup();
    const token = (await run(s, s.owner, "room.invite", { role: "DEVELOPER" }))
      .one_time as RoomInviteSecret;
    const manifest = {
      name: "Late",
      operator: { name: "Peter", contact: "p@example.com" },
      vendor: "v",
      model: "m",
      client: "mcp",
      client_version: "1",
      description: "d",
    };
    const join = () => s.d.dispatchAnonymous("room.join", { token: token.token, manifest });
    await run(s, s.owner, "room.freeze");
    await rejects(join(), "ROOM_PAUSED");
    await run(s, s.owner, "room.resume");
    await run(s, s.owner, "room.archive");
    await rejects(join(), "ROOM_PAUSED");
    const { rows } = await pool.query("SELECT used_at FROM invites WHERE room_id = $1", [s.room]);
    expect(rows[0].used_at).toBeNull();
    // An active room accepts the same invite.
    const t = await setup();
    const token2 = (await run(t, t.owner, "room.invite", { role: "DEVELOPER" }))
      .one_time as RoomInviteSecret;
    await t.d.dispatchAnonymous("room.join", { token: token2.token, manifest });
  });

  it("a deleted room's invite looks like any invalid token", async () => {
    const s = await setup();
    const token = (await run(s, s.owner, "room.invite", { role: "DEVELOPER" }))
      .one_time as RoomInviteSecret;
    await pool.query("UPDATE rooms SET status = 'DELETED' WHERE id = $1", [s.room]);
    await rejects(
      s.d.dispatchAnonymous("room.join", {
        token: token.token,
        manifest: {
          name: "x",
          operator: { name: "p", contact: "c" },
          vendor: "v",
          model: "m",
          client: "mcp",
          client_version: "1",
          description: "d",
        },
      }),
      "UNAUTHENTICATED",
    );
  });
});
