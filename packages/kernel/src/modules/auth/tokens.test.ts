import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { CrossoverError } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_MS,
  hashToken,
  issueTokens,
  refresh,
  REFRESH_TOKEN_TTL_MS,
  revokeFamily,
  revokeParticipantTokens,
} from "./tokens.js";

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

async function newParticipant(status = "ACTIVE"): Promise<{ room: string; id: string }> {
  const room = `room_${++n}`;
  const id = `part_${++n}`;
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', $2)`,
    [room, id],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, role, status)
     VALUES ($1, $2, 'HUMAN', 'Ada', 'DEVELOPER', $3)`,
    [id, room, status],
  );
  return { room, id };
}

const rows = async (family: string) =>
  (
    await pool.query(
      "SELECT kind, used_at, revoked_at FROM auth_tokens WHERE family_id = $1 ORDER BY created_at, kind",
      [family],
    )
  ).rows;

const unauthenticated = { code: "UNAUTHENTICATED" };

describe("issueTokens", () => {
  it("returns an at_ access token and an rt_ refresh token with 1 h / 30 d lifetimes", async () => {
    const { id } = await newParticipant();
    const before = Date.now();
    const pair = await issueTokens(pool, id);
    expect(pair.access_token).toMatch(/^at_[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url
    expect(pair.refresh_token).toMatch(/^rt_[A-Za-z0-9_-]{43}$/);
    expect(pair.family_id).toMatch(/^fam_/);
    const access = pair.access_expires_at.getTime() - before;
    const refreshMs = pair.refresh_expires_at.getTime() - before;
    expect(access).toBeGreaterThan(ACCESS_TOKEN_TTL_MS - 5_000);
    expect(access).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_MS + 5_000);
    expect(refreshMs).toBeGreaterThan(REFRESH_TOKEN_TTL_MS - 5_000);
    expect(refreshMs).toBeLessThanOrEqual(REFRESH_TOKEN_TTL_MS + 5_000);
  });

  it("stores only hashes: the plaintext tokens appear nowhere in the table", async () => {
    const { id } = await newParticipant();
    const pair = await issueTokens(pool, id);
    const stored = await pool.query(
      "SELECT token_hash, kind, participant_id, family_id FROM auth_tokens WHERE family_id = $1",
      [pair.family_id],
    );
    expect(stored.rows.map((r) => r.token_hash).sort()).toEqual(
      [hashToken(pair.access_token), hashToken(pair.refresh_token)].sort(),
    );
    const dump = JSON.stringify((await pool.query("SELECT * FROM auth_tokens")).rows);
    expect(dump).not.toContain(pair.access_token);
    expect(dump).not.toContain(pair.refresh_token);
    expect(dump).not.toContain(pair.access_token.slice(3));
    expect(hashToken(pair.access_token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("every call is a fresh family with fresh tokens", async () => {
    const { id } = await newParticipant();
    const [a, b] = [await issueTokens(pool, id), await issueTokens(pool, id)];
    expect(a.family_id).not.toBe(b.family_id);
    expect(new Set([a.access_token, a.refresh_token, b.access_token, b.refresh_token]).size).toBe(
      4,
    );
  });

  it("records the participant and room, and honours lifetime overrides", async () => {
    const { id, room } = await newParticipant();
    const pair = await issueTokens(pool, id, { accessTtlMs: 5_000, refreshTtlMs: 9_000 });
    const { rows: r } = await pool.query(
      "SELECT participant_id, room_id, expires_at FROM auth_tokens WHERE token_hash = $1",
      [hashToken(pair.access_token)],
    );
    expect(r[0]).toMatchObject({ participant_id: id, room_id: room });
    expect(pair.access_expires_at.getTime() - Date.now()).toBeLessThan(6_000);
    expect(pair.refresh_expires_at.getTime() - Date.now()).toBeLessThan(10_000);
  });

  it("rejects an unknown participant (NOT_FOUND) and a removed one (FORBIDDEN)", async () => {
    await expect(issueTokens(pool, "part_missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const removed = await newParticipant("REMOVED");
    await expect(issueTokens(pool, removed.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("works for invited, active and paused participants", async () => {
    for (const status of ["INVITED", "ACTIVE", "PAUSED"]) {
      const { id } = await newParticipant(status);
      await issueTokens(pool, id);
    }
  });
});

describe("refresh", () => {
  it("returns a new pair in the same family and invalidates the old refresh token", async () => {
    const { id } = await newParticipant();
    const first = await issueTokens(pool, id);
    const second = await refresh(pool, first.refresh_token);
    expect(second.family_id).toBe(first.family_id);
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    // The new refresh token works...
    await refresh(pool, second.refresh_token);
    // ...and the first is spent.
    await expect(refresh(pool, first.refresh_token)).rejects.toMatchObject(unauthenticated);
    const spent = await pool.query("SELECT used_at FROM auth_tokens WHERE token_hash = $1", [
      hashToken(first.refresh_token),
    ]);
    expect(spent.rows[0].used_at).toBeInstanceOf(Date);
  });

  it("keeps the old access token valid (until expiry) after a normal refresh", async () => {
    const { id } = await newParticipant();
    const first = await issueTokens(pool, id);
    await refresh(pool, first.refresh_token);
    const { rows } = await pool.query("SELECT revoked_at FROM auth_tokens WHERE token_hash = $1", [
      hashToken(first.access_token),
    ]);
    expect(rows[0].revoked_at).toBeNull();
  });

  // These tests are about reuse itself, so the grace window for a lost response is switched off.
  const strict = { reuseGraceSeconds: 0 };

  it("reuse of an old refresh token revokes every token in the family", async () => {
    const { id } = await newParticipant();
    const t1 = await issueTokens(pool, id);
    const t2 = await refresh(pool, t1.refresh_token);
    const t3 = await refresh(pool, t2.refresh_token);
    expect((await rows(t1.family_id)).every((r) => r.revoked_at === null)).toBe(true);

    // Someone replays the first refresh token.
    const err = await refresh(pool, t1.refresh_token, strict).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossoverError);
    expect(err).toMatchObject(unauthenticated);

    // The revocation was committed even though the call threw: all six tokens, including the
    // newest pair, are revoked.
    const after = await rows(t1.family_id);
    expect(after).toHaveLength(6);
    expect(after.every((r) => r.revoked_at instanceof Date)).toBe(true);
    await expect(refresh(pool, t3.refresh_token)).rejects.toMatchObject(unauthenticated);
  });

  it("a lost response: the spent token presented again soon after gets a new pair, and the pair nobody saw is dead", async () => {
    const { id } = await newParticipant();
    const first = await issueTokens(pool, id);
    const lost = await refresh(pool, first.refresh_token); // the client never got this answer
    const retry = await refresh(pool, first.refresh_token); // …so it asks again with the same token
    expect(retry.refresh_token).not.toBe(lost.refresh_token);
    expect(retry.family_id).toBe(first.family_id);
    // The lost pair was revoked (nobody has seen its secrets); the new pair is live.
    await expect(refresh(pool, lost.refresh_token)).rejects.toMatchObject(unauthenticated);
    const live = (await rows(first.family_id)).filter((r) => r.revoked_at === null);
    expect(live.length).toBeGreaterThanOrEqual(2); // the new access and refresh tokens
  });

  it("after a lost response the new pair works and the login survives", async () => {
    const { id } = await newParticipant();
    const first = await issueTokens(pool, id);
    await refresh(pool, first.refresh_token); // lost
    const retry = await refresh(pool, first.refresh_token);
    const next = await refresh(pool, retry.refresh_token);
    expect(next.family_id).toBe(first.family_id);
    expect(
      (await rows(first.family_id)).filter((r) => r.revoked_at === null).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("reuse after the grace window, or after the successor was used, still revokes the login", async () => {
    const { id } = await newParticipant();
    // Too late: the spent token is older than the window.
    const a = await issueTokens(pool, id);
    await refresh(pool, a.refresh_token);
    await pool.query(
      "UPDATE auth_tokens SET used_at = used_at - interval '31 seconds' WHERE token_hash = $1",
      [hashToken(a.refresh_token)],
    );
    await expect(refresh(pool, a.refresh_token)).rejects.toMatchObject(unauthenticated);
    expect((await rows(a.family_id)).every((r) => r.revoked_at instanceof Date)).toBe(true);

    // Its successor was used: someone else is already rotating this login.
    const b = await issueTokens(pool, id);
    const b2 = await refresh(pool, b.refresh_token);
    await refresh(pool, b2.refresh_token); // the successor is spent
    await expect(refresh(pool, b.refresh_token)).rejects.toMatchObject(unauthenticated);
    expect((await rows(b.family_id)).every((r) => r.revoked_at instanceof Date)).toBe(true);
  });

  it("reuse in one family doesn't touch another family or another participant", async () => {
    const a = await newParticipant();
    const b = await newParticipant();
    const [a1, a2, b1] = [
      await issueTokens(pool, a.id),
      await issueTokens(pool, a.id), // a second login, same participant
      await issueTokens(pool, b.id),
    ];
    const rotated = await refresh(pool, a1.refresh_token);
    await expect(refresh(pool, a1.refresh_token, strict)).rejects.toMatchObject(unauthenticated);
    expect((await rows(a1.family_id)).every((r) => r.revoked_at)).toBe(true);
    expect((await rows(a2.family_id)).every((r) => r.revoked_at === null)).toBe(true);
    expect((await rows(b1.family_id)).every((r) => r.revoked_at === null)).toBe(true);
    await refresh(pool, a2.refresh_token);
    await refresh(pool, b1.refresh_token);
    expect(rotated.family_id).toBe(a1.family_id);
  });

  it("concurrent refreshes with the same token: exactly one wins, and the replay revokes the family", async () => {
    const { id } = await newParticipant();
    const first = await issueTokens(pool, id);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => refresh(pool, first.refresh_token, strict)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect(r.reason).toMatchObject(unauthenticated);
    }
    // The losers' replay is indistinguishable from theft, so the family is revoked, winner's
    // new tokens included.
    expect((await rows(first.family_id)).every((r) => r.revoked_at instanceof Date)).toBe(true);
  });

  it("rejects malformed, unknown and non-refresh tokens", async () => {
    const { id } = await newParticipant();
    const pair = await issueTokens(pool, id);
    for (const bad of [
      "",
      "nope",
      "rt_",
      "rt_unknown",
      pair.access_token, // an access token isn't a refresh token
      pair.refresh_token.slice(3), // missing prefix
      undefined as unknown as string,
      42 as unknown as string,
    ]) {
      await expect(refresh(pool, bad), String(bad)).rejects.toMatchObject(unauthenticated);
    }
    // None of that burned the real token.
    await refresh(pool, pair.refresh_token);
  });

  it("rejects an expired refresh token", async () => {
    const { id } = await newParticipant();
    const pair = await issueTokens(pool, id, { refreshTtlMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    await expect(refresh(pool, pair.refresh_token)).rejects.toMatchObject(unauthenticated);
  });

  it("rejects a revoked refresh token", async () => {
    const { id } = await newParticipant();
    const pair = await issueTokens(pool, id);
    await revokeFamily(pool, pair.family_id);
    await expect(refresh(pool, pair.refresh_token)).rejects.toMatchObject(unauthenticated);
  });

  it("rejects a refresh for a participant who has since been removed", async () => {
    const { id } = await newParticipant();
    const pair = await issueTokens(pool, id);
    await pool.query("UPDATE participants SET status = 'REMOVED' WHERE id = $1", [id]);
    await expect(refresh(pool, pair.refresh_token)).rejects.toMatchObject(unauthenticated);
  });

  it("carries the lifetime overrides to the new pair", async () => {
    const { id } = await newParticipant();
    const first = await issueTokens(pool, id);
    const second = await refresh(pool, first.refresh_token, {
      accessTtlMs: 2_000,
      refreshTtlMs: 3_000,
    });
    expect(second.access_expires_at.getTime() - Date.now()).toBeLessThan(3_000);
    expect(second.refresh_expires_at.getTime() - Date.now()).toBeLessThan(4_000);
  });
});

describe("revocation helpers", () => {
  it("revokeFamily revokes one login's tokens and reports how many", async () => {
    const { id } = await newParticipant();
    const [a, b] = [await issueTokens(pool, id), await issueTokens(pool, id)];
    expect(await revokeFamily(pool, a.family_id)).toBe(2);
    expect(await revokeFamily(pool, a.family_id)).toBe(0); // idempotent
    expect((await rows(b.family_id)).every((r) => r.revoked_at === null)).toBe(true);
  });

  it("revokeParticipantTokens revokes every login of that participant only", async () => {
    const [p, q] = [await newParticipant(), await newParticipant()];
    const [p1, p2, q1] = [
      await issueTokens(pool, p.id),
      await issueTokens(pool, p.id),
      await issueTokens(pool, q.id),
    ];
    await refresh(pool, p1.refresh_token); // 4 + 2 rows for p
    expect(await revokeParticipantTokens(pool, p.id)).toBe(6);
    expect((await rows(p1.family_id)).every((r) => r.revoked_at)).toBe(true);
    expect((await rows(p2.family_id)).every((r) => r.revoked_at)).toBe(true);
    expect((await rows(q1.family_id)).every((r) => r.revoked_at === null)).toBe(true);
  });
});

describe("auth_tokens table", () => {
  it("rejects a token for a participant in a different room (composite FK)", async () => {
    const [a, b] = [await newParticipant(), await newParticipant()];
    await expect(
      pool.query(
        `INSERT INTO auth_tokens (token_hash, kind, participant_id, room_id, family_id, expires_at)
         VALUES ('h1', 'ACCESS', $1, $2, 'fam_x', now())`,
        [a.id, b.room],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects an unknown kind and used_at on an access token", async () => {
    const { id, room } = await newParticipant();
    await expect(
      pool.query(
        `INSERT INTO auth_tokens (token_hash, kind, participant_id, room_id, family_id, expires_at)
         VALUES ('h2', 'SESSION', $1, $2, 'fam_x', now())`,
        [id, room],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO auth_tokens (token_hash, kind, participant_id, room_id, family_id, expires_at, used_at)
         VALUES ('h3', 'ACCESS', $1, $2, 'fam_x', now(), now())`,
        [id, room],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
