import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerInviteCommands } from "../invites/invite.js";
import { registerMessageCommands } from "../messages/messages.js";
import { registerInboxCommands } from "../inbox/inbox.js";
import { registerApprovalCommands } from "./approvals.js";

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
const read = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
});

async function setup() {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerMessageCommands(d);
  registerApprovalCommands(d);
  registerInboxCommands(d);
  registerInviteCommands(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  const add = async (
    kind: "HUMAN" | "AGENT",
    authority: "OWNER" | "ADMIN" | "MEMBER",
    role: string,
  ): Promise<Principal> => {
    const id = newId("part");
    await pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, $3, $1, $4, $5, 'ACTIVE')`,
      [id, room, kind, authority, role],
    );
    return { participant_id: id, room_id: room, kind, authority, role } as Principal;
  };
  const owner = await add("HUMAN", "OWNER", "DEVELOPER");
  const admin = await add("HUMAN", "ADMIN", "DEVELOPER");
  const lead = await add("AGENT", "MEMBER", "LEAD");
  const dev = await add("AGENT", "MEMBER", "DEVELOPER");
  const gate = async (who: Principal, capability = "messages.send") => {
    await pool.query(
      `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, requires_approval, created_by)
       VALUES ($1, $2, $3, 'GRANT', $4, true, $5)`,
      [newId("grant"), room, who.participant_id, capability, owner.participant_id],
    );
  };
  const ungate = (who: Principal) =>
    pool.query(
      "UPDATE capability_grants SET ended_at = now(), ended_by = $2 WHERE participant_id = $1 AND ended_at IS NULL",
      [who.participant_id, owner.participant_id],
    );
  const send = (who: Principal, body: string, key?: string) =>
    d.dispatch(who, envelope("messages.send", { body }, key));
  const queued = async (who: Principal, body: string, key?: string) => {
    const err = await send(who, body, key).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CrossoverError);
    expect((err as CrossoverError).code).toBe("APPROVAL_REQUIRED");
    return (err as CrossoverError).details!["approval_id"] as string;
  };
  const decide = (who: Principal, id: string, decision: "approve" | "reject" = "approve") =>
    d.dispatch(who, envelope("approvals.decide", { approval_id: id, decision }));
  const messages = async () =>
    (
      await pool.query("SELECT body FROM messages WHERE room_id = $1 ORDER BY created_at", [room])
    ).rows.map((r) => r.body as string);
  const inbox = async (who: Principal) =>
    (
      await pool.query("SELECT kind FROM inbox_items WHERE participant_id = $1", [
        who.participant_id,
      ])
    ).rows.map((r) => r.kind as string);
  return {
    d,
    room,
    owner,
    admin,
    lead,
    dev,
    gate,
    ungate,
    send,
    queued,
    decide,
    messages,
    inbox,
    add,
  };
}

const failsWith = async (p: Promise<unknown>, code: string, reason?: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  if (reason) expect((err as CrossoverError).details).toMatchObject({ reason });
  return err as CrossoverError;
};

describe("approval gates (§22.2, T905)", () => {
  it("the owner and admins are told and decide; the lead is neither told nor allowed", async () => {
    const s = await setup();
    await s.gate(s.dev);
    const id = await s.queued(s.dev, "ship it");
    expect(await s.inbox(s.owner)).toEqual(["APPROVAL"]);
    expect(await s.inbox(s.admin)).toEqual(["APPROVAL"]);
    expect(await s.inbox(s.lead)).toEqual([]);
    expect(await s.inbox(s.dev)).toEqual([]);

    await failsWith(s.decide(s.lead, id), "FORBIDDEN");
    expect(await s.messages()).toEqual([]);
    const out = await s.decide(s.admin, id);
    expect(out.response).toMatchObject({
      approval: { status: "APPROVED", decided_by: s.admin.participant_id },
    });
    expect(await s.messages()).toEqual(["ship it"]);
  });

  it("only the owner and admins see everyone's requests, with their params; others see their own", async () => {
    const s = await setup();
    await s.gate(s.dev);
    await s.gate(s.lead);
    await s.queued(s.dev, "dev's");
    await s.queued(s.lead, "lead's");
    const list = async (who: Principal) =>
      (
        (await s.d.dispatch(who, read("approvals.list", {}))).response as {
          approvals: { requester_id: string; params: { body: string } }[];
        }
      ).approvals;
    expect((await list(s.owner)).map((a) => a.params.body).sort()).toEqual(["dev's", "lead's"]);
    expect((await list(s.admin)).length).toBe(2);
    expect((await list(s.lead)).map((a) => a.params.body)).toEqual(["lead's"]);
    expect((await list(s.dev)).map((a) => a.params.body)).toEqual(["dev's"]);
  });

  it("paging: oldest first, `after` continues, an unknown cursor is NOT_FOUND", async () => {
    const s = await setup();
    await s.gate(s.dev);
    const ids = [
      await s.queued(s.dev, "a"),
      await s.queued(s.dev, "b"),
      await s.queued(s.dev, "c"),
    ];
    type Page = { approvals: { id: string }[]; has_more: boolean };
    const first = (await s.d.dispatch(s.owner, read("approvals.list", { limit: 2 })))
      .response as Page;
    expect(first.approvals.map((a) => a.id)).toEqual(ids.slice(0, 2));
    expect(first.has_more).toBe(true);
    const second = (
      await s.d.dispatch(s.owner, read("approvals.list", { limit: 2, after: ids[1] }))
    ).response as Page;
    expect(second.approvals.map((a) => a.id)).toEqual([ids[2]]);
    await failsWith(
      s.d.dispatch(s.owner, read("approvals.list", { after: "appr_nope" })),
      "NOT_FOUND",
    );
  });

  it("a retry after the approval replays the result, even if the gate has been lifted: it never runs twice", async () => {
    const s = await setup();
    await s.gate(s.dev);
    const key = "dev-key-1";
    const id = await s.queued(s.dev, "once", key);
    await s.decide(s.owner, id);
    await s.ungate(s.dev); // the gate is gone: the retry would simply run
    const retry = await s.send(s.dev, "once", key);
    expect(retry.replayed).toBe(true);
    expect(retry.response).toMatchObject({ body: "once" });
    expect(await s.messages()).toEqual(["once"]);
    // The same key with other content is the usual key-reuse error.
    await failsWith(s.send(s.dev, "different", key), "VALIDATION");
  });

  it("a retry long after the approval, with the gate still on, doesn't open a second approval or run again", async () => {
    const s = await setup();
    await s.gate(s.dev);
    const key = "dev-key-2";
    const id = await s.queued(s.dev, "once", key);
    await s.decide(s.owner, id);
    // Past the idempotency key's 24 hours, the key itself is forgotten.
    await pool.query("DELETE FROM idempotency_keys WHERE participant_id = $1", [
      s.dev.participant_id,
    ]);
    const err = await failsWith(s.send(s.dev, "once", key), "VALIDATION", "already_approved");
    expect(err.details!["approval_id"]).toBe(id);
    expect(await s.messages()).toEqual(["once"]);
    const pending = await pool.query(
      "SELECT 1 FROM approvals WHERE room_id = $1 AND status = 'PENDING'",
      [s.room],
    );
    expect(pending.rowCount).toBe(0);
  });

  it("rejected and withdrawn requests stay that way for the same key; a new key asks again", async () => {
    const s = await setup();
    await s.gate(s.dev);
    const rejected = await s.queued(s.dev, "no", "key-r");
    await s.decide(s.owner, rejected, "reject");
    await failsWith(s.send(s.dev, "no", "key-r"), "VALIDATION", "rejected");

    const mine = await s.queued(s.dev, "changed my mind", "key-w");
    await failsWith(
      s.d.dispatch(s.lead, envelope("approvals.withdraw", { approval_id: mine })),
      "NOT_FOUND",
    );
    const out = await s.d.dispatch(s.dev, envelope("approvals.withdraw", { approval_id: mine }));
    expect(out.response).toMatchObject({ approval: { status: "WITHDRAWN" } });
    await failsWith(s.send(s.dev, "changed my mind", "key-w"), "VALIDATION", "withdrawn");
    await failsWith(s.decide(s.owner, mine), "VALIDATION", "already_decided");
    expect(await s.messages()).toEqual([]);
    await s.queued(s.dev, "no", "key-new");
  });

  it("a command that returns a one-time secret can't wait for approval", async () => {
    const s = await setup();
    await s.gate(s.lead, "room.invite");
    await failsWith(
      s.d.dispatch(s.lead, envelope("room.invite", { role: "DEVELOPER" })),
      "VALIDATION",
      "not_approvable",
    );
    const waiting = await pool.query("SELECT 1 FROM approvals WHERE room_id = $1", [s.room]);
    expect(waiting.rowCount).toBe(0);
  });

  it("a paused requester or a frozen room stops an approved command, which stays pending; the refusal names the requester", async () => {
    const s = await setup();
    await s.gate(s.dev);
    const id = await s.queued(s.dev, "later");
    await pool.query("UPDATE participants SET status = 'PAUSED' WHERE id = $1", [
      s.dev.participant_id,
    ]);
    await failsWith(s.decide(s.owner, id), "PARTICIPANT_PAUSED");
    await pool.query("UPDATE participants SET status = 'ACTIVE' WHERE id = $1", [
      s.dev.participant_id,
    ]);

    await pool.query("UPDATE rooms SET status = 'PAUSED' WHERE id = $1", [s.room]);
    // The owner may act in a frozen room, but the requester may not: the command doesn't run.
    await failsWith(s.decide(s.owner, id), "ROOM_PAUSED");
    await pool.query("UPDATE rooms SET status = 'ACTIVE' WHERE id = $1", [s.room]);
    expect(await s.messages()).toEqual([]);

    await pool.query(
      "UPDATE capability_grants SET ended_at = now(), ended_by = $2 WHERE participant_id = $1",
      [s.dev.participant_id, s.owner.participant_id],
    );
    await pool.query(
      `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, created_by)
       VALUES ($1, $2, $3, 'DENY', 'messages.send', $4)`,
      [newId("grant"), s.room, s.dev.participant_id, s.owner.participant_id],
    );
    // A revoked capability: the approver's attempt is refused, and the denial says whose it was.
    await failsWith(s.decide(s.owner, id), "FORBIDDEN");
    const denied = await pool.query(
      "SELECT actor_id, payload FROM events WHERE room_id = $1 AND type = 'capability.denied' ORDER BY sequence DESC LIMIT 1",
      [s.room],
    );
    expect(denied.rows[0].payload).toMatchObject({ on_behalf_of: s.dev.participant_id });
    expect(
      (await pool.query("SELECT status FROM approvals WHERE id = $1", [id])).rows[0].status,
    ).toBe("PENDING");
  });
});
