import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId, type RoomEvent } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import type { EventPublisher } from "../../publisher.js";
import { registerInviteCommands } from "../invites/invite.js";

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

async function setup(
  options: { publisher?: EventPublisher; onDenialRecordError?: (e: unknown) => void } = {},
) {
  const d = new Dispatcher({
    pool,
    authorize,
    nodeId: `node-${++n}`,
    ...(options.publisher ? { publisher: options.publisher } : {}),
    ...(options.onDenialRecordError ? { onDenialRecordError: options.onDenialRecordError } : {}),
  });
  registerInviteCommands(d);
  const room = newId("room");
  const ownerId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', $2)`,
    [room, ownerId],
  );
  const add = async (
    kind: "HUMAN" | "AGENT",
    authority: string,
    role: string,
    id = newId("part"),
  ) => {
    await pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, $3, $1, $4, $5, 'ACTIVE')`,
      [id, room, kind, authority, role],
    );
    return { participant_id: id, room_id: room, kind, authority, role } as Principal;
  };
  const owner = await add("HUMAN", "OWNER", "LEAD", ownerId);
  const dev = await add("AGENT", "MEMBER", "DEVELOPER");
  return { d, room, owner, dev };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const deny = (s: Setup, who: Principal, capability: string) =>
  pool.query(
    `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, created_by, created_at)
     VALUES ($1, $2, $3, 'DENY', $4, $3, clock_timestamp())`,
    [newId("grant"), s.room, who.participant_id, capability],
  );

const events = async (s: Setup, type = "capability.denied") =>
  (
    await pool.query(
      "SELECT sequence, actor_id, causation_id, payload FROM events WHERE room_id = $1 AND type = $2 ORDER BY sequence",
      [s.room, type],
    )
  ).rows;
const lastSequence = async (s: Setup) =>
  Number(
    (await pool.query("SELECT last_sequence FROM rooms WHERE id = $1", [s.room])).rows[0]
      .last_sequence,
  );

const failsWith = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

function register(
  s: Setup,
  method: "tasks.create" | "tasks.list",
  fn: (
    ctx: Parameters<Parameters<Dispatcher["registerCommand"]>[0]["execute"]>[0],
  ) => Promise<void>,
) {
  s.d.registerCommand({
    method,
    ...(method === "tasks.list" ? { action: "tasks.read" } : {}),
    mutating: method === "tasks.create",
    ...(method === "tasks.create" ? {} : { view: "none" as const, view_reason: "test fixture" }),
    params: z.object({}),
    execute: async (ctx) => {
      await fn(ctx);
      return { response: { ok: true } };
    },
  });
}

describe("capability.denied (T215)", () => {
  it("a denied command leaves exactly one capability.denied event and no other change", async () => {
    const s = await setup();
    const before = await lastSequence(s);
    const err = await failsWith(
      s.d.dispatch(s.dev, cmd("room.invite", { role: "DEVELOPER" })),
      "FORBIDDEN",
    );
    expect(err.details).toMatchObject({ missing_capability: "room.invite" });
    const denied = await events(s);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      sequence: String(before + 1),
      actor_id: s.dev.participant_id,
      payload: {
        action: "room.invite",
        resource: {},
        missing_capability: "room.invite",
        method: "room.invite",
      },
    });
    expect(await lastSequence(s)).toBe(before + 1);
    const invites = await pool.query("SELECT 1 FROM invites WHERE room_id = $1", [s.room]);
    expect(invites.rows).toHaveLength(0);
    const all = await pool.query("SELECT type FROM events WHERE room_id = $1", [s.room]);
    expect(all.rows.map((r) => r.type)).toEqual(["capability.denied"]);
  });

  it("is causally linked to the command and is not cached under its idempotency key", async () => {
    const s = await setup();
    const envelope = cmd("room.invite", { role: "DEVELOPER" });
    await failsWith(s.d.dispatch(s.dev, envelope), "FORBIDDEN");
    expect((await events(s))[0].causation_id).toBe(envelope.id);
    // The key wasn't spent: once the actor may, the same envelope works.
    await pool.query("UPDATE participants SET authority = 'MEMBER', role = 'LEAD' WHERE id = $1", [
      s.dev.participant_id,
    ]);
    await pool.query(
      `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, created_by, created_at)
       VALUES ($1, $2, $3, 'GRANT', 'room.invite', $4, clock_timestamp())`,
      [newId("grant"), s.room, s.dev.participant_id, s.owner.participant_id],
    );
    const out = await s.d.dispatch(s.dev, envelope);
    expect(out.replayed).toBe(false);
  });

  it("records a denied read too", async () => {
    const s = await setup();
    register(s, "tasks.list", async () => {});
    await deny(s, s.dev, "tasks.read");
    await failsWith(
      s.d.dispatch(s.dev, { id: newId("cmd"), method: "tasks.list", params: {} }),
      "FORBIDDEN",
    );
    const denied = await events(s);
    expect(denied).toHaveLength(1);
    expect(denied[0].payload).toMatchObject({
      action: "tasks.read",
      missing_capability: "tasks.read",
      reason: "revoked",
      method: "tasks.list",
    });
  });

  it("records a per-path denial that fails the command, with the path as the resource", async () => {
    const s = await setup();
    register(s, "tasks.create", async (ctx) => {
      await ctx.authorize("workspace.write", {
        path: "secrets/key.pem",
        note: { nested: true },
        size: 3,
      });
    });
    await deny(s, s.dev, "workspace.write:secrets/**");
    await failsWith(s.d.dispatch(s.dev, cmd("tasks.create")), "FORBIDDEN");
    const denied = await events(s);
    expect(denied).toHaveLength(1);
    expect(denied[0].payload).toEqual({
      action: "workspace.write",
      resource: { path: "secrets/key.pem", size: 3 }, // non-scalars are dropped
      missing_capability: "workspace.write",
      reason: "revoked",
      method: "tasks.create",
    });
  });

  it("truncates a long resource value", async () => {
    const s = await setup();
    register(s, "tasks.create", async (ctx) => {
      await ctx.authorize("workspace.write", { path: "a".repeat(5000) });
    });
    await deny(s, s.dev, "workspace.write");
    await failsWith(s.d.dispatch(s.dev, cmd("tasks.create")), "FORBIDDEN");
    expect((await events(s))[0].payload.resource.path).toHaveLength(256);
  });

  it("does not record a denial the command caught and carried on from", async () => {
    const s = await setup();
    register(s, "tasks.create", async (ctx) => {
      await ctx.authorize("workspace.write", { path: "secrets/k" }).catch(() => undefined);
    });
    await deny(s, s.dev, "workspace.write:secrets/**");
    await s.d.dispatch(s.dev, cmd("tasks.create"));
    expect(await events(s)).toHaveLength(0);
  });

  it("marks a denial of another participant's check (authorizeAs) as theirs", async () => {
    const s = await setup();
    register(s, "tasks.create", async (ctx) => {
      await ctx.authorizeAs(s.dev.participant_id, "room.invite");
    });
    await failsWith(s.d.dispatch(s.owner, cmd("tasks.create")), "FORBIDDEN");
    const denied = await events(s);
    expect(denied).toHaveLength(1);
    expect(denied[0].payload).toMatchObject({
      action: "room.invite",
      on_behalf_of: s.dev.participant_id,
    });
  });

  it("does not record a FORBIDDEN the command raised itself", async () => {
    const s = await setup();
    register(s, "tasks.create", async () => {
      throw new CrossoverError("FORBIDDEN", "no, by the command's own rule");
    });
    await failsWith(s.d.dispatch(s.dev, cmd("tasks.create")), "FORBIDDEN");
    expect(await events(s)).toHaveLength(0);
  });

  it("does not record paused participants or approval gates", async () => {
    const s = await setup();
    register(s, "tasks.create", async () => {});
    await pool.query(
      `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, requires_approval, created_by, created_at)
       VALUES ($1, $2, $3, 'GRANT', 'tasks.create', true, $3, clock_timestamp())`,
      [newId("grant"), s.room, s.dev.participant_id],
    );
    await failsWith(s.d.dispatch(s.dev, cmd("tasks.create")), "APPROVAL_REQUIRED");
    await pool.query(
      "UPDATE capability_grants SET ended_at = clock_timestamp(), ended_by = $1 WHERE participant_id = $1",
      [s.dev.participant_id],
    );
    await pool.query("UPDATE participants SET status = 'PAUSED' WHERE id = $1", [
      s.dev.participant_id,
    ]);
    await failsWith(s.d.dispatch(s.dev, cmd("tasks.create")), "PARTICIPANT_PAUSED");
    expect(await events(s)).toHaveLength(0);
  });

  it("publishes the event after it is stored", async () => {
    const published: RoomEvent[] = [];
    const publisher = {
      publish: vi.fn(async (_room: string, evs: RoomEvent[]) => void published.push(...evs)),
    } as unknown as EventPublisher;
    const s = await setup({ publisher });
    await failsWith(s.d.dispatch(s.dev, cmd("room.invite", { role: "DEVELOPER" })), "FORBIDDEN");
    expect(published.map((e) => e.type)).toEqual(["capability.denied"]);
  });

  it("ten concurrent denials leave ten events in consecutive sequence", async () => {
    const s = await setup();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        s.d.dispatch(s.dev, cmd("room.invite", { role: "DEVELOPER" })).catch(() => undefined),
      ),
    );
    const seqs = (await events(s)).map((e) => Number(e.sequence));
    expect(seqs).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it("a failure to record it is reported and never replaces the FORBIDDEN", async () => {
    const reported: unknown[] = [];
    const s = await setup({ onDenialRecordError: (e) => reported.push(e) });
    await pool.query("ALTER TABLE events RENAME TO events_x");
    try {
      await failsWith(s.d.dispatch(s.dev, cmd("room.invite", { role: "DEVELOPER" })), "FORBIDDEN");
    } finally {
      await pool.query("ALTER TABLE events_x RENAME TO events");
    }
    expect(reported).toHaveLength(1);
  });
});
