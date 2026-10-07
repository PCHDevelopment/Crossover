import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import { z } from "zod";
import { authenticate } from "./authenticate.js";
import { issueTokens, refresh, revokeFamily, revokeParticipantTokens } from "./tokens.js";

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

async function newParticipant(
  fields: { kind?: string; authority?: string; role?: string; status?: string } = {},
): Promise<{ room: string; id: string }> {
  const room = `room_${++n}`;
  const id = `part_${++n}`;
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', $2)`,
    [room, id],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, $3, 'Ada', $4, $5, $6)`,
    [
      id,
      room,
      fields.kind ?? "HUMAN",
      fields.authority ?? "MEMBER",
      fields.role ?? "DEVELOPER",
      fields.status ?? "ACTIVE",
    ],
  );
  return { room, id };
}

const rejected = { code: "UNAUTHENTICATED" };

describe("authenticate", () => {
  it("resolves a valid access token to the participant, room, kind, authority and role", async () => {
    const { id, room } = await newParticipant({ authority: "OWNER", role: "LEAD" });
    const pair = await issueTokens(pool, id);
    expect(await authenticate(pool, pair.access_token)).toEqual({
      participant_id: id,
      room_id: room,
      kind: "HUMAN",
      authority: "OWNER",
      role: "LEAD",
    });
  });

  it("reports an agent's kind and its role", async () => {
    const { id } = await newParticipant({ kind: "AGENT", role: "REVIEWER" });
    const pair = await issueTokens(pool, id);
    expect(await authenticate(pool, pair.access_token)).toMatchObject({
      kind: "AGENT",
      authority: "MEMBER",
      role: "REVIEWER",
    });
  });

  it("reflects the participant's current role and authority, not the ones at issue time", async () => {
    const { id } = await newParticipant({ role: "DEVELOPER" });
    const pair = await issueTokens(pool, id);
    await pool.query("UPDATE participants SET role = 'OBSERVER' WHERE id = $1", [id]);
    expect(await authenticate(pool, pair.access_token)).toMatchObject({ role: "OBSERVER" });
  });

  it("scopes each token to its own participant's room", async () => {
    const [a, b] = [await newParticipant(), await newParticipant()];
    const [ta, tb] = [await issueTokens(pool, a.id), await issueTokens(pool, b.id)];
    expect((await authenticate(pool, ta.access_token)).room_id).toBe(a.room);
    expect((await authenticate(pool, tb.access_token)).room_id).toBe(b.room);
  });

  it("works on a transaction client too", async () => {
    const { id } = await newParticipant();
    const pair = await issueTokens(pool, id);
    const client = await pool.connect();
    try {
      expect((await authenticate(client, pair.access_token)).participant_id).toBe(id);
    } finally {
      client.release();
    }
  });

  describe("rejections (UNAUTHENTICATED)", () => {
    it("a malformed token", async () => {
      for (const bad of ["", "nope", "at_", "Bearer at_x", " at_x", undefined, null, 42, {}]) {
        await expect(
          authenticate(pool, bad as unknown as string),
          String(bad),
        ).rejects.toMatchObject(rejected);
      }
    });

    it("an unknown token", async () => {
      await expect(authenticate(pool, `at_${"A".repeat(43)}`)).rejects.toMatchObject(rejected);
    });

    it("a refresh token (only access tokens authenticate)", async () => {
      const { id } = await newParticipant();
      const pair = await issueTokens(pool, id);
      await expect(authenticate(pool, pair.refresh_token)).rejects.toMatchObject(rejected);
      // ...even with the access prefix glued on, since only the hash is looked up.
      await expect(authenticate(pool, `at_${pair.refresh_token.slice(3)}`)).rejects.toMatchObject(
        rejected,
      );
    });

    it("an expired token", async () => {
      const { id } = await newParticipant();
      const pair = await issueTokens(pool, id, { accessTtlMs: 50 });
      expect((await authenticate(pool, pair.access_token)).participant_id).toBe(id);
      await new Promise((r) => setTimeout(r, 120));
      await expect(authenticate(pool, pair.access_token)).rejects.toMatchObject(rejected);
    });

    it("a revoked token (family revoke, participant revoke, reuse detection)", async () => {
      const a = await newParticipant();
      const byFamily = await issueTokens(pool, a.id);
      await revokeFamily(pool, byFamily.family_id);
      await expect(authenticate(pool, byFamily.access_token)).rejects.toMatchObject(rejected);

      const b = await newParticipant();
      const byParticipant = await issueTokens(pool, b.id);
      await revokeParticipantTokens(pool, b.id);
      await expect(authenticate(pool, byParticipant.access_token)).rejects.toMatchObject(rejected);

      const c = await newParticipant();
      const first = await issueTokens(pool, c.id);
      const second = await refresh(pool, first.refresh_token);
      await refresh(pool, first.refresh_token, { reuseGraceSeconds: 0 }).catch(() => {}); // replay → family revoked
      await expect(authenticate(pool, second.access_token)).rejects.toMatchObject(rejected);
      await expect(authenticate(pool, first.access_token)).rejects.toMatchObject(rejected);
    });

    it("a token of a REMOVED participant", async () => {
      const { id } = await newParticipant();
      const pair = await issueTokens(pool, id);
      await pool.query("UPDATE participants SET status = 'REMOVED' WHERE id = $1", [id]);
      await expect(authenticate(pool, pair.access_token)).rejects.toMatchObject(rejected);
    });

    it("gives the same generic error for every case, and never echoes the token", async () => {
      const { id } = await newParticipant();
      const pair = await issueTokens(pool, id);
      await revokeFamily(pool, pair.family_id);
      const errors = await Promise.all([
        authenticate(pool, pair.access_token).catch((e: unknown) => e),
        authenticate(pool, "garbage").catch((e: unknown) => e),
        authenticate(pool, `at_${"B".repeat(43)}`).catch((e: unknown) => e),
      ]);
      for (const err of errors) {
        expect(err).toBeInstanceOf(CrossoverError);
        expect((err as CrossoverError).message).toBe("Invalid or expired token");
        expect(JSON.stringify((err as CrossoverError).toErrorBody())).not.toContain(
          pair.access_token,
        );
      }
    });
  });

  describe("statuses that still authenticate", () => {
    it("paused and invited participants (the policy decides what they may do)", async () => {
      for (const status of ["PAUSED", "INVITED", "ACTIVE"]) {
        const { id } = await newParticipant({ status });
        const pair = await issueTokens(pool, id);
        expect((await authenticate(pool, pair.access_token)).participant_id).toBe(id);
      }
    });
  });

  it("an old access token keeps working after a normal refresh, and the new one works too", async () => {
    const { id } = await newParticipant();
    const first = await issueTokens(pool, id);
    const second = await refresh(pool, first.refresh_token);
    expect((await authenticate(pool, first.access_token)).participant_id).toBe(id);
    expect((await authenticate(pool, second.access_token)).participant_id).toBe(id);
  });
});

describe("authenticate → dispatch", () => {
  it("the principal it returns is what the dispatcher takes", async () => {
    const { id, room } = await newParticipant({ role: "LEAD", authority: "OWNER" });
    const pair = await issueTokens(pool, id);
    const principal = await authenticate(pool, pair.access_token);

    const seen: unknown[] = [];
    const d = new Dispatcher({
      pool,
      authorize: async (p) => void seen.push(p),
      nodeId: `node-${++n}`,
    });
    d.registerCommand({
      method: "room.get_state",
      params: z.object({}),
      mutating: false,
      view: "none",
      view_reason: "test fixture",
      execute: async (ctx) => ({ response: ctx.principal.participant_id }),
    });
    const out = await d.dispatch(principal, {
      id: newId("cmd"),
      method: "room.get_state",
      params: {},
    });
    expect(out.response).toBe(id);
    expect(seen).toEqual([
      { participant_id: id, room_id: room, kind: "HUMAN", authority: "OWNER", role: "LEAD" },
    ]);
  });
});
