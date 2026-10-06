import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerCapabilityCommands } from "../capabilities/grants.js";
import { registerParticipantRoleCommand } from "./role.js";

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

let keyN = 0;
const cmd = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `k-${++keyN}`,
});

interface Room {
  d: Dispatcher;
  room: string;
  owner: Principal;
  admin: Principal;
  agentLead: Principal;
  agent: Principal;
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

/** One room: an owner, an admin, an agent lead, a developer agent and a developer human. */
async function setup(): Promise<Room> {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerParticipantRoleCommand(d);
  registerCapabilityCommands(d);
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
    agentLead: await add(room, "AGENT", "MEMBER", "LEAD"),
    agent: await add(room, "AGENT", "MEMBER", "DEVELOPER"),
    human: await add(room, "HUMAN", "MEMBER", "DEVELOPER"),
  };
}

const setRole = (r: Room, who: Principal, target: Principal, role: string) =>
  r.d.dispatch(who, cmd("participants.set_role", { participant_id: target.participant_id, role }));

const roleOf = async (p: Principal) =>
  (await pool.query("SELECT role FROM participants WHERE id = $1", [p.participant_id])).rows[0]
    .role;

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

const can = (r: Room, who: Principal, action: string) =>
  authorize(who, action, { room_id: r.room }, { method: "x", params: {}, client: pool }).then(
    () => true,
    () => false,
  );

describe("participants.set_role", () => {
  it("lets the owner set any non-lead role; the change applies on the target's next command", async () => {
    const r = await setup();
    expect(await can(r, r.agent, "sandbox.exec")).toBe(true);
    expect(await can(r, r.agent, "tasks.review")).toBe(false);
    const out = await setRole(r, r.owner, r.agent, "REVIEWER");
    expect(out.response).toEqual({
      participant_id: r.agent.participant_id,
      from_role: "DEVELOPER",
      to_role: "REVIEWER",
      changed: true,
    });
    expect(await roleOf(r.agent)).toBe("REVIEWER");
    expect(await can(r, r.agent, "sandbox.exec")).toBe(false);
    expect(await can(r, r.agent, "tasks.review")).toBe(true);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      type: "participant.role_changed",
      actor_id: r.owner.participant_id,
      payload: {
        participant_id: r.agent.participant_id,
        from_role: "DEVELOPER",
        to_role: "REVIEWER",
        changed_by: r.owner.participant_id,
      },
    });
    await setRole(r, r.owner, r.human, "OBSERVER");
    expect(await roleOf(r.human)).toBe("OBSERVER");
  });

  it("lets an admin set roles, but not the owner's", async () => {
    const r = await setup();
    await setRole(r, r.admin, r.agent, "OBSERVER");
    expect(await roleOf(r.agent)).toBe("OBSERVER");
    const err = await rejects(setRole(r, r.admin, r.owner, "OBSERVER"), "FORBIDDEN");
    expect(err.details).toMatchObject({ reason: "owner_role" });
    expect(await roleOf(r.owner)).toBe("DEVELOPER");
    await setRole(r, r.owner, r.owner, "REVIEWER"); // the owner may change their own
    expect(await roleOf(r.owner)).toBe("REVIEWER");
  });

  describe("agent lead limits (§6.3)", () => {
    it("may change an agent's role", async () => {
      const r = await setup();
      await setRole(r, r.agentLead, r.agent, "OBSERVER");
      expect(await roleOf(r.agent)).toBe("OBSERVER");
    });

    it("may not change a human, an admin or the owner (FORBIDDEN)", async () => {
      const r = await setup();
      for (const target of [r.human, r.admin, r.owner]) {
        await rejects(setRole(r, r.agentLead, target, "OBSERVER"), "FORBIDDEN");
      }
      expect(await roleOf(r.human)).toBe("DEVELOPER");
      expect(await roleOf(r.admin)).toBe("DEVELOPER");
      expect(await roleOf(r.owner)).toBe("DEVELOPER");
    });

    it("never grants what it doesn't hold: a revoked capability can't be handed out via a role", async () => {
      const r = await setup();
      // tasks.review comes with REVIEWER; take it from the lead.
      await r.d.dispatch(
        r.owner,
        cmd("capabilities.revoke", {
          participant_id: r.agentLead.participant_id,
          capability: "tasks.review",
        }),
      );
      const err = await rejects(setRole(r, r.agentLead, r.agent, "REVIEWER"), "FORBIDDEN");
      expect(err.details).toMatchObject({ missing_capability: "tasks.review" });
      expect(await roleOf(r.agent)).toBe("DEVELOPER");
      // Roles that add nothing the lead lacks are still fine.
      await setRole(r, r.agentLead, r.agent, "OBSERVER");
      expect(await roleOf(r.agent)).toBe("OBSERVER");
      // The owner isn't bound by the lead's limits.
      await setRole(r, r.owner, r.agent, "REVIEWER");
      expect(await roleOf(r.agent)).toBe("REVIEWER");
    });
  });

  it("a human lead (not owner/admin) may change human members, but not an admin or the owner", async () => {
    const r = await setup();
    const lead = await add(r.room, "HUMAN", "MEMBER", "LEAD");
    await setRole(r, lead, r.human, "REVIEWER");
    expect(await roleOf(r.human)).toBe("REVIEWER");
    await rejects(setRole(r, lead, r.admin, "OBSERVER"), "FORBIDDEN");
    await rejects(setRole(r, lead, r.owner, "OBSERVER"), "FORBIDDEN");
  });

  it("refuses everyone who doesn't have the capability", async () => {
    const r = await setup();
    const reviewer = await add(r.room, "AGENT", "MEMBER", "REVIEWER");
    const observer = await add(r.room, "AGENT", "MEMBER", "OBSERVER");
    for (const who of [r.agent, reviewer, observer, r.human]) {
      await rejects(setRole(r, who, r.agent, "OBSERVER"), "FORBIDDEN");
    }
    expect(await roleOf(r.agent)).toBe("DEVELOPER");
  });

  describe("the lead", () => {
    it("can't be set through this command: role LEAD → VALIDATION", async () => {
      const r = await setup();
      for (const who of [r.owner, r.admin, r.agentLead]) {
        await rejects(setRole(r, who, r.agent, "LEAD"), "VALIDATION");
      }
      expect(await roleOf(r.agent)).toBe("DEVELOPER");
      expect(
        (
          await pool.query("SELECT 1 FROM participants WHERE room_id = $1 AND role = 'LEAD'", [
            r.room,
          ])
        ).rowCount,
      ).toBe(1);
    });

    it("can't be demoted through this command either", async () => {
      const r = await setup();
      await rejects(setRole(r, r.owner, r.agentLead, "DEVELOPER"), "VALIDATION");
      expect(await roleOf(r.agentLead)).toBe("LEAD");
    });
  });

  it("validates its input and its target", async () => {
    const r = await setup();
    const other = await setup();
    await rejects(setRole(r, r.owner, r.agent, "BOSS"), "VALIDATION");
    await rejects(
      r.d.dispatch(
        r.owner,
        cmd("participants.set_role", { participant_id: r.agent.participant_id }),
      ),
      "VALIDATION",
    );
    await rejects(
      r.d.dispatch(
        r.owner,
        cmd("participants.set_role", {
          participant_id: r.agent.participant_id,
          role: "OBSERVER",
          authority: "OWNER",
        }),
      ),
      "VALIDATION",
    );
    await rejects(
      r.d.dispatch(
        r.owner,
        cmd("participants.set_role", { participant_id: "part_nope", role: "OBSERVER" }),
      ),
      "NOT_FOUND",
    );
    await rejects(setRole(r, r.owner, other.agent, "OBSERVER"), "NOT_FOUND"); // another room
    const removed = await add(r.room, "AGENT", "MEMBER", "DEVELOPER", "REMOVED");
    await rejects(setRole(r, r.owner, removed, "OBSERVER"), "VALIDATION");
  });

  it("works for paused and invited participants", async () => {
    const r = await setup();
    const paused = await add(r.room, "AGENT", "MEMBER", "DEVELOPER", "PAUSED");
    const invited = await add(r.room, "AGENT", "MEMBER", "DEVELOPER", "INVITED");
    await setRole(r, r.owner, paused, "OBSERVER");
    await setRole(r, r.owner, invited, "REVIEWER");
    expect(await roleOf(paused)).toBe("OBSERVER");
    expect(await roleOf(invited)).toBe("REVIEWER");
  });

  it("setting the current role changes nothing and emits no event", async () => {
    const r = await setup();
    const out = await setRole(r, r.owner, r.agent, "DEVELOPER");
    expect(out.response).toMatchObject({ changed: false });
    expect(out.events).toEqual([]);
  });

  it("is idempotent per key", async () => {
    const r = await setup();
    const envelope = cmd("participants.set_role", {
      participant_id: r.agent.participant_id,
      role: "OBSERVER",
    });
    const a = await r.d.dispatch(r.owner, envelope);
    const b = await r.d.dispatch(r.owner, envelope);
    expect(b.replayed).toBe(true);
    expect(b.response).toEqual(a.response);
    const { rows } = await pool.query(
      "SELECT 1 FROM events WHERE room_id = $1 AND type = 'participant.role_changed'",
      [r.room],
    );
    expect(rows).toHaveLength(1);
  });

  it("two concurrent changes leave a consistent role and one event per real change", async () => {
    const r = await setup();
    await Promise.all([
      setRole(r, r.owner, r.agent, "REVIEWER"),
      setRole(r, r.admin, r.agent, "OBSERVER"),
    ]);
    const final = await roleOf(r.agent);
    expect(["REVIEWER", "OBSERVER"]).toContain(final);
    const { rows } = await pool.query(
      "SELECT payload FROM events WHERE room_id = $1 AND type = 'participant.role_changed' ORDER BY sequence",
      [r.room],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].payload.from_role).toBe("DEVELOPER");
    expect(rows[1].payload.from_role).toBe(rows[0].payload.to_role);
    expect(rows[1].payload.to_role).toBe(final);
  });
});
