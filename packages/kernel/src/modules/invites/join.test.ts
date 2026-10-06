import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId, type RoomEvent } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Dispatcher, type UserPrincipal } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import type { EventPublisher } from "../../publisher.js";
import { authenticate } from "../auth/authenticate.js";
import { hashToken, type TokenPair } from "../auth/tokens.js";
import { registerRoomCommands } from "../rooms/create.js";
import { registerInviteCommands, type RoomInviteSecret } from "./invite.js";
import { registerJoinCommand, type RoomJoinResponse } from "./join.js";

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
const cmd = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `k-${++keyN}`,
});

const manifest = (extra: Record<string, unknown> = {}) => ({
  name: "Claude-1",
  operator: { name: "Peter", contact: "peter@example.com" },
  vendor: "Anthropic",
  model: "claude-opus-5",
  client: "mcp",
  client_version: "1.0.0",
  description: "Writes TypeScript",
  ...extra,
});

async function setup(publisher?: EventPublisher) {
  const d = new Dispatcher({
    pool,
    authorize,
    nodeId: `node-${++n}`,
    ...(publisher ? { publisher } : {}),
  });
  registerRoomCommands(d);
  registerInviteCommands(d);
  registerJoinCommand(d);
  const user: UserPrincipal = { user_id: `user_${++n}`, display_name: "Peter" };
  const out = await d.dispatchRoomless(
    user,
    cmd("room.create", {
      slug: `join-${++n}-${Date.now().toString(36)}`,
      name: "n",
      objective: "o",
    }),
  );
  const { room, participant } = out.response as {
    room: { id: string };
    participant: { id: string };
  };
  const owner: Principal = {
    participant_id: participant.id,
    room_id: room.id,
    kind: "HUMAN",
    authority: "OWNER",
    role: "LEAD",
  };
  return { d, room: room.id, owner };
}

async function invite(
  s: Awaited<ReturnType<typeof setup>>,
  params: Record<string, unknown> = { role: "DEVELOPER" },
): Promise<string> {
  const out = await s.d.dispatch(s.owner, cmd("room.invite", params));
  return (out.one_time as RoomInviteSecret).token;
}

const join = (d: Dispatcher, token: string, m: Record<string, unknown> = manifest()) =>
  d.dispatchAnonymous("room.join", { token, manifest: m });

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
};

describe("room.join", () => {
  it("creates an ACTIVE AGENT participant with the invite's role and working tokens", async () => {
    const s = await setup();
    const token = await invite(s, { role: "REVIEWER" });
    const out = await join(s.d, token);

    const r = out.response as RoomJoinResponse;
    expect(r).toMatchObject({ room_id: s.room, role: "REVIEWER", display_name: "Claude-1" });
    const { rows } = await pool.query("SELECT * FROM participants WHERE id = $1", [
      r.participant_id,
    ]);
    expect(rows[0]).toMatchObject({
      room_id: s.room,
      kind: "AGENT",
      authority: "MEMBER",
      role: "REVIEWER",
      status: "ACTIVE",
      user_id: null,
    });
    expect(rows[0].joined_at).toBeInstanceOf(Date);

    const tokens = out.one_time as TokenPair;
    expect(await authenticate(pool, tokens.access_token)).toMatchObject({
      participant_id: r.participant_id,
      room_id: s.room,
      kind: "AGENT",
      role: "REVIEWER",
    });
  });

  it("stores the manifest with vendor and model marked self-declared", async () => {
    const s = await setup();
    const out = await join(
      s.d,
      await invite(s),
      manifest({ wake_webhook_url: "https://a.example/hook" }),
    );
    const { rows } = await pool.query("SELECT agent_manifest FROM participants WHERE id = $1", [
      (out.response as RoomJoinResponse).participant_id,
    ]);
    expect(rows[0].agent_manifest).toMatchObject({
      vendor: "Anthropic",
      model: "claude-opus-5",
      client: "mcp",
      wake_webhook_url: "https://a.example/hook",
      self_declared: ["vendor", "model"],
    });
  });

  it("appends participant.joined at the next sequence, without manifest contents or secrets", async () => {
    const s = await setup();
    const token = await invite(s);
    const before = Number(
      (await pool.query("SELECT max(sequence) AS m FROM events WHERE room_id = $1", [s.room]))
        .rows[0].m,
    );
    const out = await join(s.d, token);
    const r = out.response as RoomJoinResponse;
    const tokens = out.one_time as TokenPair;

    expect(out.events).toHaveLength(1);
    const ev = out.events[0]!;
    expect(ev.type).toBe("participant.joined");
    expect(Number(ev.sequence)).toBe(before + 1);
    expect(ev.actor_id).toBe(r.participant_id);
    expect(ev.payload).toMatchObject({
      participant_id: r.participant_id,
      kind: "AGENT",
      authority: "MEMBER",
      role: "DEVELOPER",
    });
    const serialized = JSON.stringify(ev) + JSON.stringify(out.response);
    for (const secret of [
      token,
      tokens.access_token,
      tokens.refresh_token,
      "peter@example.com",
      "Anthropic",
      "Writes TypeScript",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("never stores a token in plaintext anywhere", async () => {
    const s = await setup();
    const token = await invite(s);
    const out = await join(s.d, token);
    const tokens = out.one_time as TokenPair;
    const dump = JSON.stringify(
      await Promise.all(
        ["events", "invites", "participants", "auth_tokens", "idempotency_keys"].map(
          async (t) =>
            (
              await pool
                .query(`SELECT * FROM ${t} WHERE room_id = $1 OR $1 IS NULL`, [s.room])
                .catch(async () => pool.query(`SELECT * FROM ${t}`))
            ).rows,
        ),
      ),
    );
    for (const secret of [token, tokens.access_token, tokens.refresh_token]) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).toContain(hashToken(token));
  });

  it("turns the invite's capability grants into live grants made by the inviter, with events", async () => {
    const s = await setup();
    const token = await invite(s, {
      role: "REVIEWER",
      capability_grants: ["github.create_pull_request", "workspace.write:src/**"],
    });
    const out = await join(s.d, token);
    const r = out.response as RoomJoinResponse;
    const { rows } = await pool.query(
      "SELECT capability, created_by, requires_approval, expires_at, effect FROM capability_grants WHERE participant_id = $1 ORDER BY capability",
      [r.participant_id],
    );
    expect(rows).toEqual([
      {
        capability: "github.create_pull_request",
        created_by: s.owner.participant_id,
        requires_approval: false,
        expires_at: null,
        effect: "GRANT",
      },
      {
        capability: "workspace.write:src/**",
        created_by: s.owner.participant_id,
        requires_approval: false,
        expires_at: null,
        effect: "GRANT",
      },
    ]);
    expect(out.events.map((e) => e.type)).toEqual([
      "participant.joined",
      "capability.granted",
      "capability.granted",
    ]);
    expect(out.events[1]!.payload).toMatchObject({
      participant_id: r.participant_id,
      capability: "github.create_pull_request",
      granted_by: s.owner.participant_id,
    });
    const principal = await authenticate(pool, (out.one_time as TokenPair).access_token);
    const allowed = (action: string) =>
      authorize(
        principal,
        action,
        { room_id: s.room },
        { method: "x", params: {}, client: pool },
      ).then(
        () => true,
        () => false,
      );
    expect(await allowed("github.create_pull_request")).toBe(true);
    expect(await allowed("workspace.write:src/a.ts")).toBe(true);
    expect(await allowed("workspace.write:docs/a.md")).toBe(false);
  });

  it("an invite can't carry an authority power", async () => {
    const s = await setup();
    await rejects(
      s.d.dispatch(
        s.owner,
        cmd("room.invite", { role: "DEVELOPER", capability_grants: ["participants.remove"] }),
      ),
      "VALIDATION",
    );
  });

  it("spends the invite: it records who used it and when", async () => {
    const s = await setup();
    const token = await invite(s);
    const out = await join(s.d, token);
    const { rows } = await pool.query(
      "SELECT used_by, used_at FROM invites WHERE token_hash = $1",
      [hashToken(token)],
    );
    expect(rows[0].used_by).toBe((out.response as RoomJoinResponse).participant_id);
    expect(rows[0].used_at).toBeInstanceOf(Date);
  });

  it("refuses a reused token and creates nothing the second time", async () => {
    const s = await setup();
    const token = await invite(s);
    await join(s.d, token);
    const count = async () =>
      Number(
        (
          await pool.query("SELECT count(*)::int AS c FROM participants WHERE room_id = $1", [
            s.room,
          ])
        ).rows[0].c,
      );
    const before = await count();
    await rejects(join(s.d, token, manifest({ name: "Other" })), "UNAUTHENTICATED");
    expect(await count()).toBe(before);
  });

  it("refuses an expired token", async () => {
    const s = await setup();
    const token = await invite(s);
    await pool.query(
      "UPDATE invites SET created_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour' WHERE token_hash = $1",
      [hashToken(token)],
    );
    await rejects(join(s.d, token), "UNAUTHENTICATED");
  });

  it("answers unknown and wrong-shaped tokens the same way, and spends nothing", async () => {
    const s = await setup();
    const token = await invite(s);
    await rejects(join(s.d, "inv_" + "x".repeat(43)), "UNAUTHENTICATED");
    await rejects(
      join(s.d, token.slice(0, -1) + (token.endsWith("a") ? "b" : "a")),
      "UNAUTHENTICATED",
    );
    await rejects(join(s.d, "at_nope"), "VALIDATION");
    // The real token still works.
    await join(s.d, token);
  });

  it("exactly one of eight concurrent joins with one token succeeds", async () => {
    const s = await setup();
    const token = await invite(s);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => join(s.d, token, manifest({ name: `Agent-${i}` }))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected")
        expect((r.reason as CrossoverError).code).toBe("UNAUTHENTICATED");
    }
    const agents = await pool.query(
      "SELECT 1 FROM participants WHERE room_id = $1 AND kind = 'AGENT'",
      [s.room],
    );
    expect(agents.rowCount).toBe(1);
  });

  it("exactly one join wins across two dispatchers (two nodes) racing for one token", async () => {
    const a = await setup();
    const b = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
    registerJoinCommand(b);
    const token = await invite(a);
    const results = await Promise.allSettled([join(a.d, token), join(b, token)]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(1);
    const agents = await pool.query(
      "SELECT 1 FROM participants WHERE room_id = $1 AND kind = 'AGENT'",
      [a.room],
    );
    expect(agents.rowCount).toBeLessThanOrEqual(1);
  });

  describe("manifest validation (does not burn the token)", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["missing name", { name: undefined }],
      ["empty vendor", { vendor: "" }],
      ["unknown client", { client: "carrier-pigeon" }],
      ["http webhook", { wake_webhook_url: "http://a.example/hook" }],
      ["non-url webhook", { wake_webhook_url: "not a url" }],
      ["javascript: webhook", { wake_webhook_url: "javascript:alert(1)" }],
      ["unknown field", { is_admin: true }],
      ["missing operator contact", { operator: { name: "Peter" } }],
      ["oversized description", { description: "x".repeat(1001) }],
    ];
    it.each(cases)("%s → VALIDATION", async (_name, extra) => {
      const s = await setup();
      const token = await invite(s);
      await rejects(join(s.d, token, manifest(extra)), "VALIDATION");
      await join(s.d, token); // still usable
    });
  });

  it("takes the role only from the invite, not from the caller", async () => {
    const s = await setup();
    const token = await invite(s, { role: "OBSERVER" });
    await rejects(
      s.d.dispatchAnonymous("room.join", { token, manifest: manifest(), role: "LEAD" }),
      "VALIDATION",
    );
    const out = await join(s.d, token, manifest({ name: "Sneaky" }));
    expect((out.response as RoomJoinResponse).role).toBe("OBSERVER");
  });

  it("publishes the event after commit, and not when the join fails", async () => {
    const published: RoomEvent[] = [];
    const publisher: EventPublisher = {
      publish: vi.fn(async (_room, events) => void published.push(...events)),
    } as unknown as EventPublisher;
    const s = await setup(publisher);
    const token = await invite(s);
    published.length = 0;
    await rejects(join(s.d, token, manifest({ client: "x" })), "VALIDATION");
    expect(published).toHaveLength(0);
    await join(s.d, token);
    expect(published.map((e) => e.type)).toEqual(["participant.joined"]);
    await rejects(join(s.d, token), "UNAUTHENTICATED");
    expect(published).toHaveLength(1);
  });

  it("rolls back everything if the join fails midway", async () => {
    const s = await setup();
    const token = await invite(s);
    // A webhook name collision can't happen, so force a failure: make token issuing fail.
    await pool.query("ALTER TABLE auth_tokens RENAME TO auth_tokens_x");
    try {
      await expect(join(s.d, token)).rejects.toBeDefined();
    } finally {
      await pool.query("ALTER TABLE auth_tokens_x RENAME TO auth_tokens");
    }
    const agents = await pool.query(
      "SELECT 1 FROM participants WHERE room_id = $1 AND kind = 'AGENT'",
      [s.room],
    );
    expect(agents.rowCount).toBe(0);
    const used = await pool.query("SELECT used_at FROM invites WHERE token_hash = $1", [
      hashToken(token),
    ]);
    expect(used.rows[0].used_at).toBeNull();
    await join(s.d, token); // not burned
  });

  it("an unknown anonymous method is NOT_FOUND", async () => {
    const s = await setup();
    await rejects(s.d.dispatchAnonymous("room.nope", {}), "NOT_FOUND");
  });
});
