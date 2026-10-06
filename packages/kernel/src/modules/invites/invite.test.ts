import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { newId, type RoomEvent } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Dispatcher, type UserPrincipal } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import type { EventPublisher } from "../../publisher.js";
import { hashToken } from "../auth/tokens.js";
import { registerRoomCommands } from "../rooms/create.js";
import {
  registerInviteCommands,
  type RoomInviteResponse,
  type RoomInviteSecret,
} from "./invite.js";

let db: TestDatabase;
let pool: Pool;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
  // Participants reference users (T216), so the fixed ids the tests use must exist.
  await pool.query(
    `INSERT INTO users (id, display_name, provider, provider_subject)
     SELECT 'user_' || g, 'Peter', 'test', 'user_' || g FROM generate_series(1, 3000) g`,
  );
});

afterAll(async () => {
  await db.drop();
});

let keyN = 0;
const cmd = (method: string, params: Record<string, unknown> = {}, key = `k-${++keyN}`) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: key,
});

interface Setup {
  d: Dispatcher;
  room: string;
  owner: Principal;
}

async function setup(publisher?: EventPublisher): Promise<Setup> {
  const d = new Dispatcher({
    pool,
    authorize,
    nodeId: `node-${++n}`,
    ...(publisher ? { publisher } : {}),
  });
  registerRoomCommands(d);
  registerInviteCommands(d);
  const user: UserPrincipal = { user_id: `user_${++n}`, display_name: "Peter" };
  const out = await d.dispatchRoomless(
    user,
    cmd("room.create", {
      slug: `inv-${++n}-${Date.now().toString(36)}`,
      name: "n",
      objective: "o",
    }),
  );
  const { room, participant } = out.response as {
    room: { id: string };
    participant: { id: string };
  };
  return {
    d,
    room: room.id,
    owner: {
      participant_id: participant.id,
      room_id: room.id,
      kind: "HUMAN",
      authority: "OWNER",
      role: "LEAD",
    },
  };
}

/** Add a participant directly and return the principal for it. */
async function member(
  s: Setup,
  fields: { role: string; authority?: string; kind?: string },
): Promise<Principal> {
  const id = newId("part");
  const kind = fields.kind ?? "HUMAN";
  const authority = fields.authority ?? "MEMBER";
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status, joined_at)
     VALUES ($1, $2, $3, 'X', $4, $5, 'ACTIVE', now())`,
    [id, s.room, kind, authority, fields.role],
  );
  return {
    participant_id: id,
    room_id: s.room,
    kind: kind as Principal["kind"],
    authority: authority as Principal["authority"],
    role: fields.role as Principal["role"],
  };
}

const invite = (s: Setup, who: Principal, params: Record<string, unknown>, key?: string) =>
  s.d.dispatch(who, cmd("room.invite", params, key));

const count = async (table: string, where = "true") =>
  Number((await pool.query(`SELECT count(*)::int AS c FROM ${table} WHERE ${where}`)).rows[0].c);

/** Every row of every table, as text: for proving a secret isn't stored anywhere. */
async function wholeDatabaseAsText(): Promise<string> {
  const { rows: tables } = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  const parts: string[] = [];
  for (const { tablename } of tables) {
    const { rows } = await pool.query(`SELECT * FROM "${tablename}"`);
    parts.push(JSON.stringify(rows));
  }
  return parts.join("\n");
}

describe("room.invite", () => {
  it("returns a one-time inv_ token (32 random bytes, base64url) and the invite's details", async () => {
    const s = await setup();
    const before = Date.now();
    const out = await invite(s, s.owner, { role: "DEVELOPER" });
    const secret = out.one_time as RoomInviteSecret;
    expect(secret.token).toMatch(/^inv_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(secret.token.slice(4), "base64url")).toHaveLength(32);
    const response = out.response as RoomInviteResponse;
    expect(response).toMatchObject({ role: "DEVELOPER", capability_grants: [] });
    expect(response.invite_id).toMatch(/^inv_[0-9A-HJKMNP-TV-Z]{26}$/);
    const ttl = new Date(response.expires_at).getTime() - before;
    expect(ttl).toBeGreaterThan(24 * 3600 * 1000 - 5_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600 * 1000 + 5_000);
    expect(out.replayed).toBe(false);
  });

  it("stores only sha256(token), plus role, grants, expiry and who created it", async () => {
    const s = await setup();
    const out = await invite(s, s.owner, {
      role: "REVIEWER",
      capability_grants: ["github.create_pull_request:org/repo", "workspace.write:docs/**"],
      expires_in: 3600,
    });
    const { token } = out.one_time as RoomInviteSecret;
    const { invite_id } = out.response as RoomInviteResponse;
    const row = (await pool.query("SELECT * FROM invites WHERE id = $1", [invite_id])).rows[0];
    expect(row).toMatchObject({
      room_id: s.room,
      token_hash: hashToken(token),
      role: "REVIEWER",
      capability_grants: ["github.create_pull_request:org/repo", "workspace.write:docs/**"],
      created_by: s.owner.participant_id,
      used_at: null,
      used_by: null,
    });
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(3_600_000);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the plaintext token appears nowhere in the database", async () => {
    const s = await setup();
    const out = await invite(s, s.owner, { role: "DEVELOPER" });
    const { token } = out.one_time as RoomInviteSecret;
    const dump = await wholeDatabaseAsText();
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token.slice(4)); // nor its random part
    expect(dump).toContain(hashToken(token)); // only the hash
  });

  it("the plaintext token is never logged", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const s = await setup();
      const out = await invite(s, s.owner, { role: "OBSERVER" });
      const { token } = out.one_time as RoomInviteSecret;
      // Also exercise the error path: a duplicate request, and a denied one.
      await invite(s, s.owner, { role: "OBSERVER" }, "same-key").catch(() => {});
      await invite(s, s.owner, { role: "OBSERVER", expires_in: 1 }).catch(() => {});
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
      expect(logged).not.toContain(token);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("each invite gets its own token and id", async () => {
    const s = await setup();
    const [a, b] = [
      await invite(s, s.owner, { role: "DEVELOPER" }),
      await invite(s, s.owner, { role: "DEVELOPER" }),
    ];
    expect((a.one_time as RoomInviteSecret).token).not.toBe((b.one_time as RoomInviteSecret).token);
    expect((a.response as RoomInviteResponse).invite_id).not.toBe(
      (b.response as RoomInviteResponse).invite_id,
    );
  });

  describe("who may invite", () => {
    it("owners and admins may", async () => {
      const s = await setup();
      const admin = await member(s, { role: "DEVELOPER", authority: "ADMIN" });
      await invite(s, s.owner, { role: "DEVELOPER" });
      await invite(s, admin, { role: "DEVELOPER" });
      expect(await count("invites", `room_id = '${s.room}'`)).toBe(2);
    });

    it("anyone else gets FORBIDDEN, naming room.invite, and nothing is created", async () => {
      const s = await setup();
      const lead = await member(s, { role: "LEAD" }); // a lead without authority isn't an admin
      const dev = await member(s, { role: "DEVELOPER" });
      const reviewer = await member(s, { role: "REVIEWER" });
      const observer = await member(s, { role: "OBSERVER" });
      const agent = await member(s, { role: "DEVELOPER", kind: "AGENT" });
      const events = await count("events", `room_id = '${s.room}'`);
      for (const who of [lead, dev, reviewer, observer, agent]) {
        await expect(invite(s, who, { role: "DEVELOPER" }), who.role).rejects.toMatchObject({
          code: "FORBIDDEN",
          details: { missing_capability: "room.invite" },
        });
      }
      expect(await count("invites", `room_id = '${s.room}'`)).toBe(0);
      expect(await count("events", `room_id = '${s.room}'`)).toBe(events);
    });

    it("a participant demoted from admin can't invite on the next command", async () => {
      const s = await setup();
      const admin = await member(s, { role: "DEVELOPER", authority: "ADMIN" });
      await invite(s, admin, { role: "DEVELOPER" });
      await pool.query("UPDATE participants SET authority = 'MEMBER' WHERE id = $1", [
        admin.participant_id,
      ]);
      await expect(invite(s, admin, { role: "DEVELOPER" })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });
  });

  describe("expires_in", () => {
    it("defaults to 24 hours; accepts 60 seconds up to 24 hours", async () => {
      const s = await setup();
      for (const seconds of [60, 3600, 86_400]) {
        const out = await invite(s, s.owner, { role: "DEVELOPER", expires_in: seconds });
        const { invite_id } = out.response as RoomInviteResponse;
        const row = (
          await pool.query("SELECT created_at, expires_at FROM invites WHERE id = $1", [invite_id])
        ).rows[0];
        expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(seconds * 1000);
      }
    });

    it("rejects more than 24 hours, less than 60 seconds, and non-integers", async () => {
      const s = await setup();
      for (const bad of [86_401, 172_800, 59, 0, -1, 1.5, "3600", null, NaN]) {
        await expect(
          invite(s, s.owner, { role: "DEVELOPER", expires_in: bad }),
          String(bad),
        ).rejects.toMatchObject({
          code: "VALIDATION",
        });
      }
      expect(await count("invites", `room_id = '${s.room}'`)).toBe(0);
    });
  });

  describe("role", () => {
    it("accepts DEVELOPER, REVIEWER and OBSERVER", async () => {
      const s = await setup();
      for (const role of ["DEVELOPER", "REVIEWER", "OBSERVER"]) await invite(s, s.owner, { role });
    });

    it("rejects LEAD (appointed with room.set_lead), unknown roles, wrong case and a missing role", async () => {
      const s = await setup();
      for (const bad of ["LEAD", "OWNER", "ADMIN", "developer", "", 5, undefined]) {
        await expect(invite(s, s.owner, { role: bad }), String(bad)).rejects.toMatchObject({
          code: "VALIDATION",
        });
      }
      await expect(invite(s, s.owner, {})).rejects.toMatchObject({ code: "VALIDATION" });
    });
  });

  describe("capability_grants", () => {
    it("accepts valid, scoped and Tier 0–2 capabilities, and drops duplicates", async () => {
      const s = await setup();
      const out = await invite(s, s.owner, {
        role: "DEVELOPER",
        capability_grants: [
          "github.read_repository",
          "github.create_pull_request:org/repo",
          "slack.post_message",
          "workspace.write:src/**",
          "slack.post_message",
        ],
      });
      expect((out.response as RoomInviteResponse).capability_grants).toEqual([
        "github.read_repository",
        "github.create_pull_request:org/repo",
        "slack.post_message",
        "workspace.write:src/**",
      ]);
    });

    it("rejects malformed capabilities with the parser's reason", async () => {
      const s = await setup();
      for (const bad of ["nope", "tasks.*", "workspace.write:../x", "", "Workspace.write"]) {
        const err = await invite(s, s.owner, { role: "DEVELOPER", capability_grants: [bad] }).catch(
          (e: unknown) => e,
        );
        expect(err, bad).toMatchObject({ code: "VALIDATION" });
      }
      await expect(
        invite(s, s.owner, { role: "DEVELOPER", capability_grants: "workspace.read" }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("rejects Tier 3 capabilities and anything unknown (which counts as Tier 3)", async () => {
      const s = await setup();
      for (const bad of [
        "aws.deploy_lambda",
        "aws.deploy_lambda:function/staging-*",
        "acme.launch_rocket",
        "capabilities.grant_tier3",
      ]) {
        await expect(
          invite(s, s.owner, { role: "DEVELOPER", capability_grants: [bad] }),
          bad,
        ).rejects.toMatchObject({ code: "VALIDATION" });
      }
      expect(await count("invites", `room_id = '${s.room}'`)).toBe(0);
    });

    it("limits the list to 50", async () => {
      const s = await setup();
      const fifty = Array.from({ length: 50 }, (_, i) => `github.read_repository:org/r${i}`);
      await invite(s, s.owner, { role: "DEVELOPER", capability_grants: fifty });
      await expect(
        invite(s, s.owner, {
          role: "DEVELOPER",
          capability_grants: [...fifty, "github.read_repository:org/extra"],
        }),
      ).rejects.toMatchObject({ code: "VALIDATION" });
    });
  });

  describe("the ledger", () => {
    it("appends participant.invited, without the token, with the invite's details", async () => {
      const s = await setup();
      const key = `k-${++keyN}`;
      const env = cmd(
        "room.invite",
        { role: "DEVELOPER", capability_grants: ["slack.post_message"] },
        key,
      );
      const out = await s.d.dispatch(s.owner, env);
      const { token } = out.one_time as RoomInviteSecret;
      const response = out.response as RoomInviteResponse;
      expect(out.events).toHaveLength(1);
      const row = (
        await pool.query("SELECT * FROM events WHERE room_id = $1 AND sequence = 3", [s.room])
      ).rows[0];
      expect(row).toMatchObject({
        type: "participant.invited",
        actor_id: s.owner.participant_id,
        causation_id: env.id,
        payload: response,
      });
      expect(JSON.stringify(row.payload)).not.toContain(token);
      expect(JSON.stringify(out.events)).not.toContain(token);
    });
  });

  describe("idempotency: a retry returns the invite but never the token", () => {
    it("a duplicate returns the stored response, no second invite, and no one_time", async () => {
      const s = await setup();
      const key = `k-${++keyN}`;
      const first = await invite(s, s.owner, { role: "DEVELOPER" }, key);
      const again = await invite(s, s.owner, { role: "DEVELOPER" }, key);
      expect((first.one_time as RoomInviteSecret).token).toBeDefined();
      expect(again.replayed).toBe(true);
      expect(again.one_time).toBeUndefined();
      expect(again.response).toEqual(first.response);
      expect(JSON.stringify(again)).not.toContain((first.one_time as RoomInviteSecret).token);
      expect(await count("invites", `room_id = '${s.room}'`)).toBe(1);
    });
  });

  describe("publishing", () => {
    it("publishes the event after commit and the token goes nowhere near Redis", async () => {
      const published: RoomEvent[][] = [];
      const publisher: EventPublisher = {
        publish: async (_room, events) => void published.push([...events]),
      };
      const s = await setup(publisher);
      published.length = 0; // ignore room.create's events
      const out = await invite(s, s.owner, { role: "OBSERVER" });
      expect(published).toHaveLength(1);
      expect(published[0]!.map((e) => e.type)).toEqual(["participant.invited"]);
      expect(JSON.stringify(published)).not.toContain((out.one_time as RoomInviteSecret).token);
    });
  });
});

describe("invites table", () => {
  async function insert(s: Setup, extra: Record<string, unknown> = {}) {
    const cols: Record<string, unknown> = {
      id: newId("inv"),
      room_id: s.room,
      token_hash: hashToken(`t-${++n}`),
      role: "DEVELOPER",
      created_by: s.owner.participant_id,
      created_at: new Date("2026-10-06T00:00:00Z"),
      expires_at: new Date("2026-10-06T12:00:00Z"),
      ...extra,
    };
    const keys = Object.keys(cols);
    return pool.query(
      `INSERT INTO invites (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(cols),
    );
  }

  it("enforces the 24 hour maximum, and that expiry is after creation", async () => {
    const s = await setup();
    await insert(s, { expires_at: new Date("2026-10-07T00:00:00Z") }); // exactly 24 h
    await expect(insert(s, { expires_at: new Date("2026-10-07T00:00:01Z") })).rejects.toMatchObject(
      { code: "23514" },
    );
    await expect(insert(s, { expires_at: new Date("2026-10-06T00:00:00Z") })).rejects.toMatchObject(
      { code: "23514" },
    );
    await expect(insert(s, { expires_at: new Date("2026-10-05T00:00:00Z") })).rejects.toMatchObject(
      { code: "23514" },
    );
  });

  it("allows only DEVELOPER, REVIEWER and OBSERVER roles", async () => {
    const s = await setup();
    for (const role of ["LEAD", "OWNER", "developer"]) {
      await expect(insert(s, { role }), role).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("keeps used_at and used_by together, and used_by in the same room", async () => {
    const s = await setup();
    const other = await setup();
    await expect(insert(s, { used_at: new Date() })).rejects.toMatchObject({ code: "23514" });
    await expect(insert(s, { used_by: s.owner.participant_id })).rejects.toMatchObject({
      code: "23514",
    });
    await insert(s, { used_at: new Date(), used_by: s.owner.participant_id });
    await expect(
      insert(s, { used_at: new Date(), used_by: other.owner.participant_id }),
    ).rejects.toMatchObject({ code: "23503" }); // a participant of another room
  });

  it("requires a unique token hash, an array of grants, and a creator from the same room", async () => {
    const s = await setup();
    const other = await setup();
    await insert(s, { token_hash: "dup" });
    await expect(insert(s, { token_hash: "dup" })).rejects.toMatchObject({ code: "23505" });
    await expect(insert(s, { capability_grants: JSON.stringify({ a: 1 }) })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insert(s, { created_by: other.owner.participant_id })).rejects.toMatchObject({
      code: "23503",
    });
  });
});
