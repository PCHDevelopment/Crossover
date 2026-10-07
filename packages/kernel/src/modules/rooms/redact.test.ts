import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId, type RoomEvent } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerRoomEventsCommand } from "./events.js";
import { redactEventFor, seesDenials } from "./redact.js";

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

const denied = (actor: string, payload: Record<string, unknown> = {}): RoomEvent =>
  ({
    room_id: "room_x",
    sequence: 1,
    actor_id: actor,
    type: "capability.denied",
    payload: {
      action: "workspace.write",
      resource: { path: "secrets/key.pem" },
      missing_capability: "workspace.write",
      reason: "revoked",
      method: "workspace.apply_changeset",
      ...payload,
    },
  }) as unknown as RoomEvent;

const viewer = (id: string, role = "DEVELOPER", authority = "MEMBER") => ({
  participant_id: id,
  role,
  authority,
});

describe("redactEventFor", () => {
  it("shows the full denial to the participant it is about, the lead, the owner and admins", () => {
    const e = denied("part_a");
    expect(redactEventFor(viewer("part_a"), e)).toBe(e);
    expect(redactEventFor(viewer("part_l", "LEAD"), e)).toBe(e);
    expect(redactEventFor(viewer("part_o", "DEVELOPER", "OWNER"), e)).toBe(e);
    expect(redactEventFor(viewer("part_m", "OBSERVER", "ADMIN"), e)).toBe(e);
  });

  it("shows a denial of someone else's check to the one it was for", () => {
    const e = denied("part_lead", { on_behalf_of: "part_b" });
    expect(redactEventFor(viewer("part_b"), e)).toBe(e);
    expect(
      (redactEventFor(viewer("part_c"), e).payload as Record<string, unknown>).resource,
    ).toBeUndefined();
  });

  it.each(["DEVELOPER", "REVIEWER", "OBSERVER"])(
    "a %s who isn't involved gets resource removed and resource_redacted",
    (role) => {
      const e = denied("part_a");
      const out = redactEventFor(viewer("part_z", role), e);
      expect(out.payload).toEqual({
        action: "workspace.write",
        missing_capability: "workspace.write",
        reason: "revoked",
        method: "workspace.apply_changeset",
        resource_redacted: true,
      });
      expect(JSON.stringify(out)).not.toContain("secrets");
      // The stored event is untouched.
      expect((e.payload as Record<string, unknown>).resource).toEqual({ path: "secrets/key.pem" });
    },
  );

  it("cuts a scope (which can name a path) off the capability names", () => {
    const e = denied("part_a", {
      action: "workspace.write:secrets/key.pem",
      missing_capability: "workspace.write:secrets/key.pem",
    });
    const out = redactEventFor(viewer("part_z"), e);
    expect(JSON.stringify(out)).not.toContain("secrets");
    expect(out.payload).toMatchObject({
      action: "workspace.write",
      missing_capability: "workspace.write",
    });
  });

  it("leaves other events alone", () => {
    const e = {
      ...denied("part_a"),
      type: "task.created",
      payload: { resource: { path: "x" } },
    } as unknown as RoomEvent;
    expect(redactEventFor(viewer("part_z"), e)).toBe(e);
  });

  it("who sees denials: lead, owner, admin", () => {
    expect(seesDenials(viewer("a", "LEAD"))).toBe(true);
    expect(seesDenials(viewer("a", "DEVELOPER", "OWNER"))).toBe(true);
    expect(seesDenials(viewer("a", "REVIEWER", "ADMIN"))).toBe(true);
    for (const role of ["DEVELOPER", "REVIEWER", "OBSERVER"])
      expect(seesDenials(viewer("a", role))).toBe(false);
  });
});

describe("room.events.list redacts capability.denied for other readers", () => {
  async function setup() {
    const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
    registerRoomEventsCommand(d);
    d.registerCommand({
      method: "tasks.create",
      mutating: true,
      params: z.object({}),
      execute: async (ctx) => {
        await ctx.authorize("workspace.write", { path: "secrets/key.pem" });
        return { response: {} };
      },
    });
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
    const who = {
      owner: await add("HUMAN", "OWNER", "DEVELOPER", ownerId),
      admin: await add("HUMAN", "ADMIN", "DEVELOPER"),
      lead: await add("AGENT", "MEMBER", "LEAD"),
      actor: await add("AGENT", "MEMBER", "DEVELOPER"),
      other: await add("AGENT", "MEMBER", "DEVELOPER"),
      reviewer: await add("AGENT", "MEMBER", "REVIEWER"),
      observer: await add("AGENT", "MEMBER", "OBSERVER"),
    };
    await pool.query(
      `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, created_by, created_at)
       VALUES ($1, $2, $3, 'DENY', 'workspace.write:secrets/**', $3, clock_timestamp())`,
      [newId("grant"), room, who.actor.participant_id],
    );
    const err = await d
      .dispatch(who.actor, {
        id: newId("cmd"),
        method: "tasks.create",
        params: {},
        idempotency_key: `k-${++n}`,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossoverError);
    return { d, who };
  }

  const list = async (d: Dispatcher, p: Principal) =>
    (
      (
        await d.dispatch(p, {
          id: newId("cmd"),
          method: "room.events.list",
          params: { types: ["capability.denied"] },
        })
      ).response as {
        events: RoomEvent[];
      }
    ).events;

  it("the actor, lead, owner and admin see the path; other developers, reviewers and observers don't", async () => {
    const { d, who } = await setup();
    for (const p of [who.actor, who.lead, who.owner, who.admin]) {
      const [e] = await list(d, p);
      expect((e!.payload as { resource: unknown }).resource).toEqual({ path: "secrets/key.pem" });
    }
    for (const p of [who.other, who.reviewer, who.observer]) {
      const events = await list(d, p);
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("secrets");
      expect(events[0]!.payload).toMatchObject({
        resource_redacted: true,
        missing_capability: "workspace.write",
      });
    }
  });

  it("the stored event keeps the full record", async () => {
    const { d, who } = await setup();
    await list(d, who.other);
    const { rows } = await pool.query(
      "SELECT payload FROM events WHERE room_id = $1 AND type = 'capability.denied'",
      [who.actor.room_id],
    );
    expect(rows[0].payload.resource).toEqual({ path: "secrets/key.pem" });
  });

  it("viewing doesn't itself record a denial", async () => {
    const { d, who } = await setup();
    await list(d, who.other);
    await list(d, who.observer);
    const { rows } = await pool.query(
      "SELECT 1 FROM events WHERE room_id = $1 AND type = 'capability.denied'",
      [who.actor.room_id],
    );
    expect(rows).toHaveLength(1);
  });
});
