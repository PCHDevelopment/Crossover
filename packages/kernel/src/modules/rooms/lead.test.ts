import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Dispatcher, type Authorizer } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { LEAD_OFFER_TTL_SECONDS, registerLeadCommands } from "./lead.js";

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
  owner: Principal; // human owner, the initial lead (as room.create makes them)
  admin: Principal;
  agent: Principal;
  agent2: Principal;
  observer: Principal;
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

async function setup(authorizer: Authorizer = authorize): Promise<Room> {
  const d = new Dispatcher({ pool, authorize: authorizer, nodeId: `node-${++n}` });
  registerLeadCommands(d);
  const room = newId("room");
  const ownerId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id, lead_participant_id) VALUES ($1, $1, 'n', 'o', $2, $2)`,
    [room, ownerId],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'owner', 'OWNER', 'LEAD', 'ACTIVE')`,
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
      role: "LEAD",
    },
    admin: await add(room, "HUMAN", "ADMIN", "DEVELOPER"),
    agent: await add(room, "AGENT", "MEMBER", "DEVELOPER"),
    agent2: await add(room, "AGENT", "MEMBER", "REVIEWER"),
    observer: await add(room, "AGENT", "MEMBER", "OBSERVER"),
    human: await add(room, "HUMAN", "MEMBER", "DEVELOPER"),
  };
}

const run = (r: Room, who: Principal, method: string, params: Record<string, unknown> = {}) =>
  r.d.dispatch(who, cmd(method, params));
const setLead = (r: Room, who: Principal, to: Principal) =>
  run(r, who, "room.set_lead", { participant_id: to.participant_id });
const offer = (r: Room, who: Principal, to: Principal) =>
  run(r, who, "room.transfer_lead", { participant_id: to.participant_id });
const accept = (r: Room, who: Principal) => run(r, who, "room.accept_lead");

/** Principals are snapshots; the policy re-reads role, so a stale one still reflects the database. */
const roleOf = async (p: Principal) =>
  (await pool.query("SELECT role FROM participants WHERE id = $1", [p.participant_id])).rows[0]
    .role;

async function expectOneLead(r: Room, leadId: string) {
  const leads = await pool.query(
    "SELECT id FROM participants WHERE room_id = $1 AND role = 'LEAD' AND status <> 'REMOVED'",
    [r.room],
  );
  expect(leads.rows.map((x) => x.id)).toEqual([leadId]);
  const room = await pool.query("SELECT lead_participant_id FROM rooms WHERE id = $1", [r.room]);
  expect(room.rows[0].lead_participant_id).toBe(leadId);
}

const can = (r: Room, who: Principal, action: string) =>
  authorize(who, action, { room_id: r.room }, { method: "x", params: {}, client: pool }).then(
    () => true,
    () => false,
  );

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

/** Pretend the latest offer was made `minutes` ago. */
const ageOffer = (r: Room, minutes: number) =>
  pool.query(
    `UPDATE events SET payload = jsonb_set(payload, '{expires_at}', to_jsonb((clock_timestamp() + make_interval(mins => $2))::text))
     WHERE room_id = $1 AND type = 'lead.transfer_offered'`,
    [r.room, -minutes + 10],
  );

describe("room.set_lead", () => {
  it("lets the owner appoint an agent: one lead remains, the old lead becomes a developer", async () => {
    const r = await setup();
    expect(await can(r, r.agent, "tasks.assign")).toBe(false);
    const out = await setLead(r, r.owner, r.agent);
    expect(out.response).toEqual({
      lead: r.agent.participant_id,
      previous_lead: r.owner.participant_id,
      changed: true,
    });
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      type: "lead.changed",
      actor_id: r.owner.participant_id,
      payload: {
        from: r.owner.participant_id,
        to: r.agent.participant_id,
        reason: "appointed",
        changed_by: r.owner.participant_id,
      },
    });
    await expectOneLead(r, r.agent.participant_id);
    expect(await roleOf(r.owner)).toBe("DEVELOPER");
    expect(await can(r, r.agent, "tasks.assign")).toBe(true); // the lead bundle
    expect(await can(r, r.owner, "tasks.assign")).toBe(false);
  });

  it("lets an admin appoint a human, or put the owner back", async () => {
    const r = await setup();
    await setLead(r, r.admin, r.human);
    await expectOneLead(r, r.human.participant_id);
    await setLead(r, r.admin, r.owner);
    await expectOneLead(r, r.owner.participant_id);
  });

  it("appointing the current lead changes nothing and emits no event", async () => {
    const r = await setup();
    const out = await setLead(r, r.owner, r.owner);
    expect(out.response).toMatchObject({ changed: false });
    expect(out.events).toEqual([]);
    await expectOneLead(r, r.owner.participant_id);
  });

  it("refuses everyone who isn't owner or admin (the lead included)", async () => {
    const r = await setup();
    await setLead(r, r.owner, r.agent);
    for (const who of [r.agent, r.agent2, r.observer, r.human]) {
      await rejects(setLead(r, who, r.agent2), "FORBIDDEN");
    }
    await expectOneLead(r, r.agent.participant_id);
  });

  it("only appoints an active participant that exists in the room", async () => {
    const r = await setup();
    const other = await setup();
    await rejects(run(r, r.owner, "room.set_lead", { participant_id: "part_nope" }), "NOT_FOUND");
    await rejects(setLead(r, r.owner, other.agent), "NOT_FOUND");
    for (const status of ["PAUSED", "INVITED", "REMOVED"]) {
      const who = await add(r.room, "AGENT", "MEMBER", "DEVELOPER", status);
      await rejects(setLead(r, r.owner, who), "VALIDATION");
    }
    await expectOneLead(r, r.owner.participant_id);
  });

  it("two concurrent appointments leave exactly one lead", async () => {
    const r = await setup();
    await Promise.all([setLead(r, r.owner, r.agent), setLead(r, r.admin, r.agent2)]);
    const leads = await pool.query(
      "SELECT id FROM participants WHERE room_id = $1 AND role = 'LEAD'",
      [r.room],
    );
    expect(leads.rowCount).toBe(1);
    await expectOneLead(r, leads.rows[0].id);
  });
});

describe("room.transfer_lead and room.accept_lead", () => {
  async function leadAgent() {
    const r = await setup();
    await setLead(r, r.owner, r.agent); // the agent leads; transfers go from it
    return r;
  }

  it("offers the lead, and the recipient takes it by accepting", async () => {
    const r = await leadAgent();
    const out = await offer(r, r.agent, r.agent2);
    const expires = new Date((out.response as { expires_at: string }).expires_at).getTime();
    expect(expires - Date.now()).toBeGreaterThan((LEAD_OFFER_TTL_SECONDS - 5) * 1000);
    expect(expires - Date.now()).toBeLessThanOrEqual(LEAD_OFFER_TTL_SECONDS * 1000);
    expect(out.events[0]).toMatchObject({
      type: "lead.transfer_offered",
      actor_id: r.agent.participant_id,
      payload: { from: r.agent.participant_id, to: r.agent2.participant_id },
    });
    // Offering changes nothing yet.
    await expectOneLead(r, r.agent.participant_id);

    const done = await accept(r, r.agent2);
    expect(done.response).toEqual({
      lead: r.agent2.participant_id,
      previous_lead: r.agent.participant_id,
      changed: true,
    });
    expect(done.events[0]).toMatchObject({
      type: "lead.changed",
      actor_id: r.agent2.participant_id,
      payload: {
        from: r.agent.participant_id,
        to: r.agent2.participant_id,
        reason: "transfer_accepted",
      },
    });
    await expectOneLead(r, r.agent2.participant_id);
    expect(await roleOf(r.agent)).toBe("DEVELOPER");
  });

  it("accepting after 10 minutes is a VALIDATION error and the lead is unchanged", async () => {
    const r = await leadAgent();
    await offer(r, r.agent, r.agent2);
    await ageOffer(r, 11);
    const err = await rejects(accept(r, r.agent2), "VALIDATION");
    expect(err.message).toMatch(/expired/);
    await expectOneLead(r, r.agent.participant_id);
    expect(await roleOf(r.agent2)).toBe("REVIEWER");
  });

  it("accepting just inside the window works", async () => {
    const r = await leadAgent();
    await offer(r, r.agent, r.agent2);
    await ageOffer(r, 9);
    await accept(r, r.agent2);
    await expectOneLead(r, r.agent2.participant_id);
  });

  it("only the one offered can accept; with no offer there is nothing to accept", async () => {
    const r = await leadAgent();
    await rejects(accept(r, r.agent2), "NOT_FOUND"); // nothing offered yet
    await offer(r, r.agent, r.agent2);
    await rejects(accept(r, r.human), "NOT_FOUND");
    await rejects(accept(r, r.owner), "NOT_FOUND");
    await expectOneLead(r, r.agent.participant_id);
  });

  it("a newer offer replaces an older one", async () => {
    const r = await leadAgent();
    await offer(r, r.agent, r.agent2);
    await offer(r, r.agent, r.human);
    await rejects(accept(r, r.agent2), "NOT_FOUND");
    await accept(r, r.human);
    await expectOneLead(r, r.human.participant_id);
  });

  it("an offer is void once the lead changes another way", async () => {
    const r = await leadAgent();
    await offer(r, r.agent, r.agent2);
    await setLead(r, r.owner, r.human); // the owner appoints someone else meanwhile
    await rejects(accept(r, r.agent2), "VALIDATION");
    await expectOneLead(r, r.human.participant_id);
  });

  it("an offer stays void even if the original lead is lead again", async () => {
    const r = await leadAgent();
    await offer(r, r.agent, r.agent2);
    await setLead(r, r.owner, r.human);
    await setLead(r, r.owner, r.agent); // back to the offering lead
    await rejects(accept(r, r.agent2), "VALIDATION");
    await expectOneLead(r, r.agent.participant_id);
  });

  it("holding the capability by a grant isn't enough: only the lead can offer", async () => {
    const r = await leadAgent();
    await pool.query(
      `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, created_by, created_at)
       VALUES ($1, $2, $3, 'GRANT', 'room.transfer_lead', $4, clock_timestamp())`,
      [newId("grant"), r.room, r.human.participant_id, r.owner.participant_id],
    );
    const err = await rejects(offer(r, r.human, r.agent2), "FORBIDDEN");
    expect(err.details).toMatchObject({ reason: "not_the_lead" });
  });

  it("an accepted offer can't be accepted again", async () => {
    const r = await leadAgent();
    await offer(r, r.agent, r.agent2);
    await accept(r, r.agent2);
    await rejects(accept(r, r.agent2), "VALIDATION");
    await expectOneLead(r, r.agent2.participant_id);
  });

  it("only the current lead can offer, and the former lead can't offer any more", async () => {
    const r = await leadAgent();
    for (const who of [r.agent2, r.observer, r.human, r.admin]) {
      await rejects(offer(r, who, r.agent2), "FORBIDDEN");
    }
    await offer(r, r.agent, r.agent2);
    await accept(r, r.agent2);
    await rejects(offer(r, r.agent, r.human), "FORBIDDEN"); // no longer the lead
  });

  it("the offer must be to an active participant who can accept", async () => {
    const r = await leadAgent();
    await rejects(offer(r, r.agent, r.agent), "VALIDATION"); // self
    const err = await rejects(offer(r, r.agent, r.observer), "VALIDATION"); // observers can't accept
    expect(err.message).toMatch(/can't accept/);
    await rejects(
      run(r, r.agent, "room.transfer_lead", { participant_id: "part_nope" }),
      "NOT_FOUND",
    );
    for (const status of ["PAUSED", "INVITED", "REMOVED"]) {
      const who = await add(r.room, "AGENT", "MEMBER", "DEVELOPER", status);
      await rejects(offer(r, r.agent, who), "VALIDATION");
    }
    await expectOneLead(r, r.agent.participant_id);
  });

  it("a recipient who gets paused can't accept", async () => {
    const r = await leadAgent();
    await offer(r, r.agent, r.agent2);
    await pool.query("UPDATE participants SET status = 'PAUSED' WHERE id = $1", [
      r.agent2.participant_id,
    ]);
    await rejects(accept(r, r.agent2), "PARTICIPANT_PAUSED");
    await expectOneLead(r, r.agent.participant_id);
  });

  it("an accept is idempotent per key", async () => {
    const r = await leadAgent();
    await offer(r, r.agent, r.agent2);
    const envelope = cmd("room.accept_lead");
    const a = await r.d.dispatch(r.agent2, envelope);
    const b = await r.d.dispatch(r.agent2, envelope);
    expect(b.replayed).toBe(true);
    expect(b.response).toEqual(a.response);
    const { rows } = await pool.query(
      "SELECT 1 FROM events WHERE room_id = $1 AND type = 'lead.changed' AND payload ->> 'reason' = 'transfer_accepted'",
      [r.room],
    );
    expect(rows).toHaveLength(1);
  });

  it("asks the dispatcher's configured authorizer whether the recipient can accept, as the recipient", async () => {
    const asked: { who: string; action: string; room: unknown; method: string }[] = [];
    let deny: string | undefined;
    const spy: Authorizer = async (principal, action, resource, context) => {
      if (action === "room.accept_lead") {
        asked.push({
          who: principal.participant_id,
          action,
          room: resource.room_id,
          method: context.method,
        });
        if (principal.participant_id === deny) {
          throw new CrossoverError("FORBIDDEN", "stub says no");
        }
        return;
      }
      return authorize(principal, action, resource, context);
    };
    const r = await setup(spy);
    await setLead(r, r.owner, r.agent);
    await offer(r, r.agent, r.agent2);
    expect(asked).toEqual([
      {
        who: r.agent2.participant_id,
        action: "room.accept_lead",
        room: r.room,
        method: "room.transfer_lead",
      },
    ]);
    deny = r.human.participant_id;
    const err = await rejects(offer(r, r.agent, r.human), "VALIDATION");
    expect(err.message).toMatch(/can't accept/);
  });

  it("the owner as lead can offer too (the lead role carries the capability)", async () => {
    const r = await setup();
    await offer(r, r.owner, r.human);
    await accept(r, r.human);
    await expectOneLead(r, r.human.participant_id);
  });
});

describe("ctx.authorizeAs", () => {
  it("answers NOT_FOUND for someone outside the room, and passes for a participant who may", async () => {
    const r = await setup();
    const other = await setup();
    const results: string[] = [];
    r.d.registerCommand({
      method: "tasks.create",
      mutating: true,
      params: z.object({
        who: z.string(),
        action: z.string(),
      }),
      execute: async (ctx, p) => {
        await ctx.authorizeAs(p.who, p.action).then(
          () => results.push("allowed"),
          (e: CrossoverError) => results.push(e.code),
        );
        return { response: {} };
      },
    });
    const ask = (who: string, action: string) =>
      r.d.dispatch(r.owner, cmd("tasks.create", { who, action }));
    await ask(r.agent.participant_id, "tasks.read"); // may
    await ask(r.observer.participant_id, "tasks.create"); // may not
    await ask(other.agent.participant_id, "tasks.read"); // another room
    await ask("part_nope", "tasks.read");
    expect(results).toEqual(["allowed", "FORBIDDEN", "NOT_FOUND", "NOT_FOUND"]);
  });
});
