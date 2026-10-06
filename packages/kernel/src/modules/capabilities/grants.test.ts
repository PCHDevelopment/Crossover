import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId, type RoomEvent } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { registerCapabilityCommands } from "./grants.js";

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
  dev: Principal;
  reviewer: Principal;
  observer: Principal;
}

async function addParticipant(
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

async function setup(): Promise<Room> {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerCapabilityCommands(d);
  const room = newId("room");
  const ownerId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', $2)`,
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
    admin: await addParticipant(room, "HUMAN", "ADMIN", "DEVELOPER"),
    dev: await addParticipant(room, "AGENT", "MEMBER", "DEVELOPER"),
    reviewer: await addParticipant(room, "AGENT", "MEMBER", "REVIEWER"),
    observer: await addParticipant(room, "AGENT", "MEMBER", "OBSERVER"),
  };
}

const run = (r: Room, who: Principal, method: string, params: Record<string, unknown> = {}) =>
  r.d.dispatch(who, cmd(method, params));
const grant = (r: Room, who: Principal, to: Principal, capability: string, extra = {}) =>
  run(r, who, "capabilities.grant", { participant_id: to.participant_id, capability, ...extra });
const revoke = (r: Room, who: Principal, from: Principal, capability: string) =>
  run(r, who, "capabilities.revoke", { participant_id: from.participant_id, capability });

/** Would the policy let `who` do `action` right now? */
const can = (r: Room, who: Principal, action: string) =>
  authorize(who, action, { room_id: r.room }, { method: "x", params: {}, client: pool }).then(
    () => true,
    (e: unknown) => {
      if (e instanceof CrossoverError) return false;
      throw e;
    },
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

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

describe("capabilities.grant", () => {
  it("lets the owner grant a Tier 2 capability, which then takes effect and emits capability.granted", async () => {
    const r = await setup();
    expect(await can(r, r.dev, "github.create_pull_request")).toBe(false);
    const out = await grant(r, r.owner, r.dev, "github.create_pull_request");
    expect(out.response).toMatchObject({
      participant_id: r.dev.participant_id,
      capability: "github.create_pull_request",
      tier: 2,
      requires_approval: false,
      expires_at: null,
    });
    expect(await can(r, r.dev, "github.create_pull_request")).toBe(true);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({
      type: "capability.granted",
      actor_id: r.owner.participant_id,
      payload: {
        participant_id: r.dev.participant_id,
        capability: "github.create_pull_request",
        granted_by: r.owner.participant_id,
        expires_at: null,
      },
    });
  });

  it("lets an admin grant Tier 0–2, scoped and with an expiry", async () => {
    const r = await setup();
    await grant(r, r.admin, r.reviewer, "workspace.write:src/**", { expires_at: inHours(48) });
    expect(await can(r, r.reviewer, "workspace.write:src/a.ts")).toBe(true);
    expect(await can(r, r.reviewer, "workspace.write:docs/a.md")).toBe(false);
  });

  it("refuses everyone without the grant power (FORBIDDEN)", async () => {
    const r = await setup();
    for (const who of [r.dev, r.reviewer, r.observer]) {
      await rejects(grant(r, who, r.dev, "browser.navigate"), "FORBIDDEN");
    }
    expect(await can(r, r.dev, "browser.navigate")).toBe(false);
  });

  describe("Tier 3", () => {
    it("without expires_at → VALIDATION, whoever asks", async () => {
      const r = await setup();
      for (const who of [r.owner, r.admin]) {
        await rejects(grant(r, who, r.dev, "aws.deploy_lambda:function/prod-*"), "VALIDATION");
      }
    });

    it("by an admin, with a valid expiry → FORBIDDEN", async () => {
      const r = await setup();
      const err = await rejects(
        grant(r, r.admin, r.dev, "aws.deploy_lambda:function/prod-*", { expires_at: inHours(1) }),
        "FORBIDDEN",
      );
      expect(err.details).toMatchObject({ missing_capability: "capabilities.grant_tier3" });
      expect(await can(r, r.dev, "aws.deploy_lambda:function/prod-x")).toBe(false);
    });

    it("by the owner, with an expiry within 24 h → allowed, and it lapses", async () => {
      const r = await setup();
      const out = await grant(r, r.owner, r.dev, "aws.deploy_lambda:function/prod-*", {
        expires_at: inHours(23),
      });
      expect(out.response).toMatchObject({ tier: 3 });
      expect(await can(r, r.dev, "aws.deploy_lambda:function/prod-x")).toBe(true);
      expect(await can(r, r.dev, "aws.deploy_lambda:function/staging-x")).toBe(false);
      await pool.query(
        "UPDATE capability_grants SET created_at = created_at - interval '2 days', expires_at = clock_timestamp() - interval '1 second' WHERE participant_id = $1",
        [r.dev.participant_id],
      );
      expect(await can(r, r.dev, "aws.deploy_lambda:function/prod-x")).toBe(false);
    });

    it("beyond 24 h, or in the past → VALIDATION", async () => {
      const r = await setup();
      await rejects(
        grant(r, r.owner, r.dev, "aws.deploy_lambda", { expires_at: inHours(25) }),
        "VALIDATION",
      );
      await rejects(
        grant(r, r.owner, r.dev, "aws.deploy_lambda", { expires_at: inHours(-1) }),
        "VALIDATION",
      );
    });

    it("an unclassified capability is Tier 3 as well", async () => {
      const r = await setup();
      await rejects(grant(r, r.owner, r.dev, "nuclear.launch"), "VALIDATION");
      await rejects(
        grant(r, r.admin, r.dev, "nuclear.launch", { expires_at: inHours(1) }),
        "FORBIDDEN",
      );
      await grant(r, r.owner, r.dev, "nuclear.launch", { expires_at: inHours(1) });
    });
  });

  it("refuses to grant an authority power", async () => {
    const r = await setup();
    for (const capability of [
      "participants.remove",
      "capabilities.grant",
      "capabilities.grant_tier3",
      "room.invite",
      "room.freeze",
    ]) {
      await rejects(grant(r, r.owner, r.dev, capability), "VALIDATION");
    }
    expect(await can(r, r.dev, "participants.remove")).toBe(false);
  });

  it.each([
    ["a malformed capability", { capability: "Not A Capability" }],
    ["a wildcard", { capability: "tasks.*" }],
    ["an unknown field", { capability: "browser.navigate", reason: "because" }],
    ["a bad expiry", { capability: "browser.navigate", expires_at: "tomorrow" }],
    ["a non-boolean gate", { capability: "browser.navigate", requires_approval: "yes" }],
  ])("%s → VALIDATION", async (_name, params) => {
    const r = await setup();
    await rejects(
      run(r, r.owner, "capabilities.grant", { participant_id: r.dev.participant_id, ...params }),
      "VALIDATION",
    );
  });

  it("answers NOT_FOUND for an unknown participant or one in another room, VALIDATION for a removed one", async () => {
    const r = await setup();
    const other = await setup();
    await rejects(
      run(r, r.owner, "capabilities.grant", {
        participant_id: "part_nope",
        capability: "browser.navigate",
      }),
      "NOT_FOUND",
    );
    await rejects(grant(r, r.owner, other.dev, "browser.navigate"), "NOT_FOUND");
    const removed = await addParticipant(r.room, "AGENT", "MEMBER", "DEVELOPER", "REMOVED");
    await rejects(grant(r, r.owner, removed, "browser.navigate"), "VALIDATION");
  });

  it("granting again refreshes the one live grant instead of adding another", async () => {
    const r = await setup();
    await grant(r, r.owner, r.dev, "browser.navigate", { expires_at: inHours(1) });
    const second = await grant(r, r.admin, r.dev, "browser.navigate");
    const { rows } = await pool.query(
      "SELECT created_by, expires_at, ended_at FROM capability_grants WHERE participant_id = $1 AND capability = 'browser.navigate'",
      [r.dev.participant_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].created_by).toBe(r.admin.participant_id);
    expect(rows[0].expires_at).toBeNull();
    expect(second.response).toMatchObject({ expires_at: null });
  });

  it("ten concurrent identical grants leave exactly one live row", async () => {
    const r = await setup();
    await Promise.all(
      Array.from({ length: 10 }, () => grant(r, r.owner, r.dev, "browser.navigate")),
    );
    const { rows } = await pool.query(
      "SELECT 1 FROM capability_grants WHERE participant_id = $1 AND ended_at IS NULL",
      [r.dev.participant_id],
    );
    expect(rows).toHaveLength(1);
  });

  it("an approval-gated grant is stored, listed, and makes the capability fail closed", async () => {
    const r = await setup();
    const out = await grant(r, r.owner, r.dev, "github.create_pull_request", {
      requires_approval: true,
    });
    expect(out.response).toMatchObject({ requires_approval: true });
    const listed = await run(r, r.owner, "capabilities.list", {
      participant_id: r.dev.participant_id,
    });
    expect(listed.response).toMatchObject({
      grants: [{ capability: "github.create_pull_request", requires_approval: true }],
    });
    await rejects(
      authorize(
        r.dev,
        "github.create_pull_request",
        { room_id: r.room },
        { method: "x", params: {}, client: pool },
      ),
      "APPROVAL_REQUIRED",
    );
  });

  it("is idempotent per key: a retry replays and creates nothing new", async () => {
    const r = await setup();
    const envelope = cmd("capabilities.grant", {
      participant_id: r.dev.participant_id,
      capability: "browser.navigate",
    });
    const a = await r.d.dispatch(r.owner, envelope);
    const b = await r.d.dispatch(r.owner, envelope);
    expect(b.replayed).toBe(true);
    expect(b.response).toEqual(a.response);
    const { rows } = await pool.query(
      "SELECT 1 FROM events WHERE room_id = $1 AND type = 'capability.granted'",
      [r.room],
    );
    expect(rows).toHaveLength(1);
  });
});

describe("capabilities.revoke", () => {
  it("ends a grant, effective on the very next command, and emits capability.revoked", async () => {
    const r = await setup();
    await grant(r, r.owner, r.dev, "github.create_pull_request");
    expect(await can(r, r.dev, "github.create_pull_request")).toBe(true);
    const out = await revoke(r, r.admin, r.dev, "github.create_pull_request");
    expect(out.response).toEqual({
      participant_id: r.dev.participant_id,
      capability: "github.create_pull_request",
      grants_ended: 1,
      denied: false,
    });
    expect(await can(r, r.dev, "github.create_pull_request")).toBe(false);
    expect(out.events[0]).toMatchObject({
      type: "capability.revoked",
      payload: { revoked_by: r.admin.participant_id, grants_ended: 1, denied: false },
    });
    const { rows } = await pool.query(
      "SELECT ended_by FROM capability_grants WHERE participant_id = $1",
      [r.dev.participant_id],
    );
    expect(rows[0].ended_by).toBe(r.admin.participant_id); // history is kept
  });

  it("takes a role-bundle capability away with a DENY, leaving others alone", async () => {
    const r = await setup();
    expect(await can(r, r.dev, "sandbox.exec")).toBe(true);
    const out = await revoke(r, r.owner, r.dev, "sandbox.exec");
    expect(out.response).toMatchObject({ grants_ended: 0, denied: true });
    expect(await can(r, r.dev, "sandbox.exec")).toBe(false);
    expect(await can(r, r.dev, "workspace.write")).toBe(true);
    expect(await can(r, r.reviewer, "sandbox.exec")).toBe(false); // never had it
    // Revoking again is harmless.
    await revoke(r, r.owner, r.dev, "sandbox.exec");
    const { rows } = await pool.query(
      "SELECT 1 FROM capability_grants WHERE participant_id = $1 AND effect = 'DENY' AND ended_at IS NULL",
      [r.dev.participant_id],
    );
    expect(rows).toHaveLength(1);
  });

  it("a scoped revoke takes away only that scope of a bundle capability", async () => {
    const r = await setup();
    await revoke(r, r.owner, r.dev, "workspace.write:secrets/**");
    expect(await can(r, r.dev, "workspace.write:src/a.ts")).toBe(true);
    expect(await can(r, r.dev, "workspace.write:secrets/k")).toBe(false);
  });

  it("granting a revoked capability again restores it", async () => {
    const r = await setup();
    await revoke(r, r.owner, r.dev, "sandbox.exec");
    expect(await can(r, r.dev, "sandbox.exec")).toBe(false);
    await grant(r, r.owner, r.dev, "sandbox.exec");
    expect(await can(r, r.dev, "sandbox.exec")).toBe(true);
  });

  it("an admin can revoke a Tier 3 grant the owner made", async () => {
    const r = await setup();
    await grant(r, r.owner, r.dev, "aws.deploy_lambda:function/prod-*", { expires_at: inHours(1) });
    await revoke(r, r.admin, r.dev, "aws.deploy_lambda:function/prod-*");
    expect(await can(r, r.dev, "aws.deploy_lambda:function/prod-x")).toBe(false);
  });

  it("refuses to revoke an authority power, and answers NOT_FOUND when there is nothing to revoke", async () => {
    const r = await setup();
    await rejects(revoke(r, r.owner, r.admin, "participants.remove"), "VALIDATION");
    await rejects(revoke(r, r.owner, r.dev, "browser.navigate"), "NOT_FOUND");
    expect(await can(r, r.admin, "participants.remove")).toBe(true);
  });

  it("refuses everyone without the revoke power", async () => {
    const r = await setup();
    for (const who of [r.dev, r.reviewer, r.observer]) {
      await rejects(revoke(r, who, r.dev, "sandbox.exec"), "FORBIDDEN");
    }
    expect(await can(r, r.dev, "sandbox.exec")).toBe(true);
  });

  it("a participant who loses a capability is refused on their next command", async () => {
    const r = await setup();
    r.d.registerCommand({
      method: "tasks.create",
      action: "tasks.create",
      mutating: true,
      params: z.object({}),
      execute: async () => ({ response: { ok: true } }),
    });
    await run(r, r.dev, "tasks.create");
    await revoke(r, r.owner, r.dev, "tasks.create");
    const err = await rejects(run(r, r.dev, "tasks.create"), "FORBIDDEN");
    expect(err.details).toMatchObject({ reason: "revoked" });
  });
});

describe("path-scoped capabilities through a command, as workspace.apply_changeset uses them", () => {
  /** Mirrors workspace/apply.ts: action `workspace.write`, then a per-path `ctx.authorize`. */
  async function withApply(): Promise<Room> {
    const r = await setup();
    r.d.registerCommand({
      method: "workspace.apply_changeset",
      action: "workspace.write",
      mutating: true,
      params: z.object({ paths: z.array(z.string()) }),
      execute: async (ctx, params) => {
        for (const path of params.paths) await ctx.authorize("workspace.write", { path });
        return { response: { applied: params.paths } };
      },
    });
    return r;
  }
  const apply = (r: Room, who: Principal, paths: string[]) =>
    run(r, who, "workspace.apply_changeset", { paths });

  it("a scoped revoke refuses a ChangeSet that touches the revoked path, and only that one", async () => {
    const r = await withApply();
    await apply(r, r.dev, ["src/a.ts", "secrets/key.pem"]);
    await revoke(r, r.owner, r.dev, "workspace.write:secrets/**");
    const err = await rejects(apply(r, r.dev, ["src/a.ts", "secrets/key.pem"]), "FORBIDDEN");
    expect(err.details).toMatchObject({ reason: "revoked" });
    await rejects(apply(r, r.dev, ["secrets/.env"]), "FORBIDDEN");
    await apply(r, r.dev, ["src/a.ts", "docs/My File.md"]);
  });

  it("a scoped revoke also narrows an explicit unscoped grant", async () => {
    const r = await withApply();
    await rejects(apply(r, r.reviewer, ["src/a.ts"]), "FORBIDDEN"); // no coarse permission yet
    await grant(r, r.owner, r.reviewer, "workspace.write");
    const out = await revoke(r, r.owner, r.reviewer, "workspace.write:docs/**");
    expect(out.response).toMatchObject({ grants_ended: 0, denied: true });
    await apply(r, r.reviewer, ["src/a.ts"]);
    await rejects(apply(r, r.reviewer, ["docs/a.md"]), "FORBIDDEN");
  });

  it("a scoped grant alone doesn't pass the unscoped command-level check (it means 'every scope')", async () => {
    const r = await withApply();
    await grant(r, r.owner, r.reviewer, "workspace.write:src/**");
    await rejects(apply(r, r.reviewer, ["src/a.ts"]), "FORBIDDEN");
  });
});

describe("capabilities.list", () => {
  it("shows the bundle, live grants and revocations, but not expired or ended ones", async () => {
    const r = await setup();
    await grant(r, r.owner, r.reviewer, "github.create_pull_request", { expires_at: inHours(5) });
    await grant(r, r.owner, r.reviewer, "browser.navigate");
    await revoke(r, r.owner, r.reviewer, "browser.navigate"); // ended
    await grant(r, r.owner, r.reviewer, "slack.post_message");
    await pool.query(
      "UPDATE capability_grants SET created_at = created_at - interval '2 days', expires_at = clock_timestamp() - interval '1 second' WHERE capability = 'slack.post_message' AND participant_id = $1",
      [r.reviewer.participant_id],
    );
    await revoke(r, r.owner, r.reviewer, "workspace.read");

    const out = await run(r, r.observer, "capabilities.list", {
      participant_id: r.reviewer.participant_id,
    });
    const body = out.response as {
      role: string;
      authority: string;
      bundle: string[];
      grants: { capability: string; tier: number; expires_at: string | null }[];
      revocations: { capability: string }[];
    };
    expect(body).toMatchObject({ role: "REVIEWER", authority: "MEMBER" });
    expect(body.bundle).toContain("workspace.read");
    expect(body.bundle).not.toContain("workspace.write");
    expect(body.grants.map((g) => g.capability)).toEqual(["github.create_pull_request"]);
    expect(body.grants[0]).toMatchObject({ tier: 2 });
    expect(body.grants[0]!.expires_at).not.toBeNull();
    expect(body.revocations.map((x) => x.capability)).toEqual(["workspace.read"]);
    expect(out.events).toEqual([]);
  });

  it("defaults to the caller, and answers NOT_FOUND for someone outside the room", async () => {
    const r = await setup();
    const other = await setup();
    const out = await run(r, r.dev, "capabilities.list");
    expect(out.response).toMatchObject({ participant_id: r.dev.participant_id, role: "DEVELOPER" });
    await rejects(
      run(r, r.dev, "capabilities.list", { participant_id: other.dev.participant_id }),
      "NOT_FOUND",
    );
  });

  it("is a read: it appends no events", async () => {
    const r = await setup();
    const before = await pool.query("SELECT count(*)::int AS c FROM events WHERE room_id = $1", [
      r.room,
    ]);
    await run(r, r.dev, "capabilities.list");
    const after = await pool.query("SELECT count(*)::int AS c FROM events WHERE room_id = $1", [
      r.room,
    ]);
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });
});

describe("events", () => {
  it("are appended in order with the capability and its terms, and nothing else", async () => {
    const r = await setup();
    const g = await grant(r, r.owner, r.dev, "github.create_pull_request", {
      expires_at: inHours(3),
      requires_approval: true,
    });
    const v = await revoke(r, r.owner, r.dev, "github.create_pull_request");
    const events: RoomEvent[] = [...g.events, ...v.events];
    expect(events.map((e) => e.type)).toEqual(["capability.granted", "capability.revoked"]);
    expect(events[1]!.sequence).toBe(events[0]!.sequence + 1);
    expect(Object.keys(events[0]!.payload).sort()).toEqual(
      [
        "capability",
        "expires_at",
        "grant_id",
        "granted_by",
        "participant_id",
        "requires_approval",
        "tier",
      ].sort(),
    );
  });
});
