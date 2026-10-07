import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { authenticate } from "../auth/authenticate.js";
import { issueTokens, refresh } from "../auth/tokens.js";
import {
  registerParticipantLifecycleCommands,
  type ParticipantLifecycleOptions,
} from "./lifecycle.js";

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

interface Room {
  d: Dispatcher;
  room: string;
  owner: Principal;
  admin: Principal;
  admin2: Principal;
  lead: Principal;
  agent: Principal;
  agent2: Principal;
  human: Principal;
}

async function add(
  room: string,
  kind: "HUMAN" | "AGENT",
  authority: "OWNER" | "ADMIN" | "MEMBER",
  role: Principal["role"],
  status = "ACTIVE",
): Promise<Principal> {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, $3, $1, $4, $5, $6)`,
    [id, room, kind, authority, role, status],
  );
  return { participant_id: id, room_id: room, kind, authority, role };
}

/** One room; the lead is an agent unless `leadKind` is "HUMAN". */
async function setup(
  leadKind: "AGENT" | "HUMAN" = "AGENT",
  options: ParticipantLifecycleOptions = {},
): Promise<Room> {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerParticipantLifecycleCommands(d, options);
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
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', $2)`,
    [room, ownerId],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'owner', 'OWNER', 'DEVELOPER', 'ACTIVE')`,
    [ownerId, room],
  );
  return {
    d,
    room,
    owner: {
      participant_id: ownerId,
      room_id: room,
      kind: "HUMAN",
      authority: "OWNER",
      role: "DEVELOPER",
    },
    admin: await add(room, "HUMAN", "ADMIN", "DEVELOPER"),
    admin2: await add(room, "HUMAN", "ADMIN", "DEVELOPER"),
    lead: await add(room, leadKind, "MEMBER", "LEAD"),
    agent: await add(room, "AGENT", "MEMBER", "DEVELOPER"),
    agent2: await add(room, "AGENT", "MEMBER", "DEVELOPER"),
    human: await add(room, "HUMAN", "MEMBER", "DEVELOPER"),
  };
}

const call = (r: Room, who: Principal, method: string, target: Principal) =>
  r.d.dispatch(who, cmd(method, { participant_id: target.participant_id }));
const pause = (r: Room, who: Principal, target: Principal) =>
  call(r, who, "participants.pause", target);
const resume = (r: Room, who: Principal, target: Principal) =>
  call(r, who, "participants.resume", target);
const remove = (r: Room, who: Principal, target: Principal) =>
  call(r, who, "participants.remove", target);

const statusOf = async (p: Principal) =>
  (await pool.query("SELECT status FROM participants WHERE id = $1", [p.participant_id])).rows[0]
    .status;

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

describe("participants.pause", () => {
  it("freezes a participant: every command answers PARTICIPANT_PAUSED, but their tokens still authenticate", async () => {
    const r = await setup();
    const tokens = await issueTokens(pool, r.agent.participant_id);
    await r.d.dispatch(r.agent, cmd("tasks.create")); // fine while active
    const out = await pause(r, r.owner, r.agent);
    expect(out.response).toEqual({
      participant_id: r.agent.participant_id,
      status: "PAUSED",
      changed: true,
    });
    expect(await statusOf(r.agent)).toBe("PAUSED");
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      type: "participant.paused",
      actor_id: r.owner.participant_id,
      payload: { participant_id: r.agent.participant_id, paused_by: r.owner.participant_id },
    });
    // Reads, mutations and the pause powers themselves are all refused.
    await rejects(r.d.dispatch(r.agent, cmd("tasks.create")), "PARTICIPANT_PAUSED");
    await rejects(r.d.dispatch(r.agent, cmd("tasks.list")), "PARTICIPANT_PAUSED");
    await rejects(resume(r, r.agent, r.agent), "PARTICIPANT_PAUSED");
    await rejects(pause(r, r.agent, r.agent2), "PARTICIPANT_PAUSED");
    // Pausing doesn't revoke tokens.
    expect((await authenticate(pool, tokens.access_token)).participant_id).toBe(
      r.agent.participant_id,
    );
    // Others are unaffected.
    await r.d.dispatch(r.agent2, cmd("tasks.create"));
  });

  it("owner and admin can pause any agent or human member; only the owner can pause an admin", async () => {
    const r = await setup();
    await pause(r, r.admin, r.agent);
    await pause(r, r.admin, r.human);
    await pause(r, r.owner, r.lead);
    await pause(r, r.owner, r.admin);
    expect(await statusOf(r.admin)).toBe("PAUSED");
    const err = await rejects(pause(r, r.admin2, r.owner), "FORBIDDEN");
    expect(err.details).toMatchObject({ reason: "owner" });
    const r2 = await setup();
    const err2 = await rejects(pause(r2, r2.admin, r2.admin2), "FORBIDDEN");
    expect(err2.details).toMatchObject({ reason: "governing_target" });
    expect(await statusOf(r2.admin2)).toBe("ACTIVE");
  });

  it("nobody can pause the owner, and nobody can pause themselves", async () => {
    const r = await setup();
    await rejects(pause(r, r.owner, r.owner), "VALIDATION");
    await rejects(pause(r, r.agent, r.agent), "FORBIDDEN"); // no capability
    await rejects(pause(r, r.admin, r.admin), "VALIDATION");
    await rejects(pause(r, r.admin, r.owner), "FORBIDDEN");
    await rejects(pause(r, r.lead, r.lead), "VALIDATION");
    expect(await statusOf(r.owner)).toBe("ACTIVE");
  });

  describe("the lead (§22.1: the lead cannot pause humans)", () => {
    it("an agent lead can pause an agent", async () => {
      const r = await setup();
      await pause(r, r.lead, r.agent);
      expect(await statusOf(r.agent)).toBe("PAUSED");
    });

    it.each(["AGENT", "HUMAN"] as const)(
      "a %s lead can't pause a human, an admin or the owner",
      async (kind) => {
        const r = await setup(kind);
        for (const target of [r.human, r.admin, r.owner]) {
          await rejects(pause(r, r.lead, target), "FORBIDDEN");
        }
        expect(await statusOf(r.human)).toBe("ACTIVE");
      },
    );

    it("a human lead can pause an agent too", async () => {
      const r = await setup("HUMAN");
      await pause(r, r.lead, r.agent);
      expect(await statusOf(r.agent)).toBe("PAUSED");
    });
  });

  it("refuses roles without the capability", async () => {
    const r = await setup();
    const reviewer = await add(r.room, "AGENT", "MEMBER", "REVIEWER");
    const observer = await add(r.room, "AGENT", "MEMBER", "OBSERVER");
    for (const who of [r.agent2, reviewer, observer, r.human]) {
      await rejects(pause(r, who, r.agent), "FORBIDDEN");
    }
    expect(await statusOf(r.agent)).toBe("ACTIVE");
  });

  it("pausing an already paused participant changes nothing and emits no event", async () => {
    const r = await setup();
    await pause(r, r.owner, r.agent);
    const again = await pause(r, r.admin, r.agent);
    expect(again.response).toMatchObject({ changed: false });
    expect(again.events).toEqual([]);
  });

  it("validates the target: unknown, other room, invited and removed", async () => {
    const r = await setup();
    const other = await setup();
    await rejects(
      r.d.dispatch(r.owner, cmd("participants.pause", { participant_id: "part_nope" })),
      "NOT_FOUND",
    );
    await rejects(pause(r, r.owner, other.agent), "NOT_FOUND");
    const invited = await add(r.room, "AGENT", "MEMBER", "DEVELOPER", "INVITED");
    const removed = await add(r.room, "AGENT", "MEMBER", "DEVELOPER", "REMOVED");
    await rejects(pause(r, r.owner, invited), "VALIDATION");
    await rejects(pause(r, r.owner, removed), "VALIDATION");
    await rejects(
      r.d.dispatch(
        r.owner,
        cmd("participants.pause", { participant_id: r.agent.participant_id, reason: "x" }),
      ),
      "VALIDATION",
    );
  });
});

describe("participants.resume", () => {
  it("lets the owner resume what anyone paused; the participant works again", async () => {
    const r = await setup();
    await pause(r, r.lead, r.agent);
    const out = await resume(r, r.owner, r.agent);
    expect(out.response).toEqual({
      participant_id: r.agent.participant_id,
      status: "ACTIVE",
      changed: true,
    });
    expect(out.events[0]).toMatchObject({
      type: "participant.resumed",
      payload: { participant_id: r.agent.participant_id, resumed_by: r.owner.participant_id },
    });
    await r.d.dispatch(r.agent, cmd("tasks.create"));
  });

  describe("only a human can un-pause what a human paused (§6.3)", () => {
    it("an agent lead can resume an agent paused by an agent", async () => {
      const r = await setup();
      await pause(r, r.lead, r.agent);
      await resume(r, r.lead, r.agent);
      expect(await statusOf(r.agent)).toBe("ACTIVE");
    });

    it.each([
      ["the owner", (r: Room) => r.owner],
      ["an admin", (r: Room) => r.admin],
    ])("an agent lead can't resume an agent paused by %s", async (_n, who) => {
      const r = await setup();
      await pause(r, who(r), r.agent);
      const err = await rejects(resume(r, r.lead, r.agent), "FORBIDDEN");
      expect(err.details).toMatchObject({ reason: "paused_by_human" });
      expect(await statusOf(r.agent)).toBe("PAUSED");
      await resume(r, who(r), r.agent); // a human can
      expect(await statusOf(r.agent)).toBe("ACTIVE");
    });

    it("a human lead can resume an agent paused by the owner", async () => {
      const r = await setup("HUMAN");
      await pause(r, r.owner, r.agent);
      await resume(r, r.lead, r.agent);
      expect(await statusOf(r.agent)).toBe("ACTIVE");
    });

    it("a pause with no pause event on record counts as a human's", async () => {
      const r = await setup();
      await pool.query("UPDATE participants SET status = 'PAUSED' WHERE id = $1", [
        r.agent.participant_id,
      ]);
      await rejects(resume(r, r.lead, r.agent), "FORBIDDEN");
      await resume(r, r.owner, r.agent);
    });

    it("the latest pause decides who paused", async () => {
      const r = await setup();
      await pause(r, r.owner, r.agent); // human
      await resume(r, r.owner, r.agent);
      await pause(r, r.lead, r.agent); // agent
      await resume(r, r.lead, r.agent);
      expect(await statusOf(r.agent)).toBe("ACTIVE");
    });
  });

  it("the lead can't resume humans, admins or the owner", async () => {
    const r = await setup("HUMAN");
    await pause(r, r.owner, r.human);
    await rejects(resume(r, r.lead, r.human), "FORBIDDEN");
    await resume(r, r.admin, r.human);
    await pause(r, r.owner, r.admin);
    await rejects(resume(r, r.admin2, r.admin), "FORBIDDEN"); // only the owner touches admins
    await resume(r, r.owner, r.admin);
    expect(await statusOf(r.admin)).toBe("ACTIVE");
  });

  it("resuming an active participant changes nothing; invited and removed are VALIDATION", async () => {
    const r = await setup();
    const out = await resume(r, r.owner, r.agent);
    expect(out.response).toMatchObject({ changed: false });
    expect(out.events).toEqual([]);
    await rejects(
      resume(r, r.owner, await add(r.room, "AGENT", "MEMBER", "DEVELOPER", "INVITED")),
      "VALIDATION",
    );
    await rejects(
      resume(r, r.owner, await add(r.room, "AGENT", "MEMBER", "DEVELOPER", "REMOVED")),
      "VALIDATION",
    );
  });

  it("is refused without the capability", async () => {
    const r = await setup();
    await pause(r, r.owner, r.agent);
    await rejects(resume(r, r.agent2, r.agent), "FORBIDDEN");
    await rejects(resume(r, r.human, r.agent), "FORBIDDEN");
  });
});

describe("participants.remove", () => {
  it("removes a participant and revokes every token they hold, in every family", async () => {
    const r = await setup();
    const a = await issueTokens(pool, r.agent.participant_id);
    const b = await issueTokens(pool, r.agent.participant_id);
    const bystander = await issueTokens(pool, r.agent2.participant_id);
    const out = await remove(r, r.owner, r.agent);
    expect(out.response).toEqual({
      participant_id: r.agent.participant_id,
      status: "REMOVED",
      tokens_revoked: 4,
    });
    expect(await statusOf(r.agent)).toBe("REMOVED");
    expect(out.events[0]).toMatchObject({
      type: "participant.removed",
      payload: {
        participant_id: r.agent.participant_id,
        removed_by: r.owner.participant_id,
        tokens_revoked: 4,
      },
    });
    for (const t of [a, b]) {
      await rejects(authenticate(pool, t.access_token), "UNAUTHENTICATED");
      await rejects(refresh(pool, t.refresh_token), "UNAUTHENTICATED");
    }
    expect((await authenticate(pool, bystander.access_token)).participant_id).toBe(
      r.agent2.participant_id,
    );
  });

  it("works on a paused participant, and an admin can do it", async () => {
    const r = await setup();
    await pause(r, r.owner, r.agent);
    await remove(r, r.admin, r.agent);
    await remove(r, r.admin, r.human);
    expect(await statusOf(r.agent)).toBe("REMOVED");
    expect(await statusOf(r.human)).toBe("REMOVED");
  });

  it("only the owner can remove an admin; nobody can remove the owner, the lead or themselves", async () => {
    const r = await setup();
    await rejects(remove(r, r.admin, r.admin2), "FORBIDDEN");
    await rejects(remove(r, r.admin, r.owner), "FORBIDDEN");
    await rejects(remove(r, r.owner, r.owner), "VALIDATION");
    await rejects(remove(r, r.admin, r.admin), "VALIDATION");
    const err = await rejects(remove(r, r.owner, r.lead), "VALIDATION");
    expect(err.message).toMatch(/set_lead/);
    await remove(r, r.owner, r.admin2);
    expect(await statusOf(r.admin2)).toBe("REMOVED");
    expect(await statusOf(r.lead)).toBe("ACTIVE");
  });

  it("is refused to the lead and everyone else without the capability", async () => {
    const r = await setup();
    for (const who of [r.lead, r.agent2, r.human]) {
      await rejects(remove(r, who, r.agent), "FORBIDDEN");
    }
    expect(await statusOf(r.agent)).toBe("ACTIVE");
  });

  it("refuses an already removed or unknown participant", async () => {
    const r = await setup();
    await remove(r, r.owner, r.agent);
    await rejects(remove(r, r.owner, r.agent), "VALIDATION");
    await rejects(
      r.d.dispatch(r.owner, cmd("participants.remove", { participant_id: "part_nope" })),
      "NOT_FOUND",
    );
  });

  it("runs onRemove inside the transaction (a failure rolls the removal back) and afterRemove after the commit", async () => {
    const seen: string[] = [];
    const r = await setup("AGENT", {
      onRemove: async (client, info) => {
        const { rows } = await client.query("SELECT status FROM participants WHERE id = $1", [
          info.participant_id,
        ]);
        seen.push(`onRemove:${rows[0].status}`);
      },
      afterRemove: (info) =>
        void seen.push(`after:${info.participant_id === r.agent.participant_id}`),
    });
    const tokens = await issueTokens(pool, r.agent.participant_id);
    await remove(r, r.owner, r.agent);
    expect(seen).toEqual(["onRemove:REMOVED", "after:true"]);
    await rejects(authenticate(pool, tokens.access_token), "UNAUTHENTICATED");

    const failing = vi.fn().mockRejectedValue(new Error("task release failed"));
    const after = vi.fn();
    const r2 = await setup("AGENT", { onRemove: failing, afterRemove: after });
    const t2 = await issueTokens(pool, r2.agent.participant_id);
    await expect(remove(r2, r2.owner, r2.agent)).rejects.toThrow("task release failed");
    expect(await statusOf(r2.agent)).toBe("ACTIVE");
    expect((await authenticate(pool, t2.access_token)).participant_id).toBe(
      r2.agent.participant_id,
    );
    expect(after).not.toHaveBeenCalled();
  });

  it("is idempotent per key: a retry replays without a second event", async () => {
    const r = await setup();
    const envelope = cmd("participants.remove", { participant_id: r.agent.participant_id });
    const a = await r.d.dispatch(r.owner, envelope);
    const b = await r.d.dispatch(r.owner, envelope);
    expect(b.replayed).toBe(true);
    expect(b.response).toEqual(a.response);
    const { rows } = await pool.query(
      "SELECT 1 FROM events WHERE room_id = $1 AND type = 'participant.removed'",
      [r.room],
    );
    expect(rows).toHaveLength(1);
  });
});
