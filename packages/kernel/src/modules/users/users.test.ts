import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { CrossoverError } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../auth/tokens.js";
import {
  authenticateUser,
  createUserSession,
  findOrCreateUser,
  revokeUserSession,
  revokeUserSessions,
  USER_SESSION_TTL_MS,
} from "./users.js";

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

const identity = (extra: Partial<Parameters<typeof findOrCreateUser>[1]> = {}) => ({
  provider: "dev",
  subject: `sub-${++n}`,
  display_name: "Peter",
  ...extra,
});

const rejectsUnauthenticated = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe("UNAUTHENTICATED");
};

describe("findOrCreateUser", () => {
  it("creates a usr_ user, and resolves the same subject to the same user without renaming", async () => {
    const who = identity();
    const a = await findOrCreateUser(pool, who);
    const b = await findOrCreateUser(pool, { ...who, display_name: "Renamed" });
    expect(a.id).toMatch(/^usr_/);
    expect(b).toEqual(a);
    expect(b.display_name).toBe("Peter");
  });

  it("keeps providers apart: the same subject under two providers is two users", async () => {
    const sub = `shared-${++n}`;
    const a = await findOrCreateUser(pool, identity({ subject: sub, provider: "dev" }));
    const b = await findOrCreateUser(pool, identity({ subject: sub, provider: "github" }));
    expect(a.id).not.toBe(b.id);
  });

  it("twenty concurrent calls for one identity create one user", async () => {
    const who = identity();
    const users = await Promise.all(Array.from({ length: 20 }, () => findOrCreateUser(pool, who)));
    expect(new Set(users.map((u) => u.id)).size).toBe(1);
    const { rows } = await pool.query("SELECT 1 FROM users WHERE provider_subject = $1", [
      who.subject,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("refuses an empty display name, subject or a malformed provider (database checks)", async () => {
    await expect(findOrCreateUser(pool, identity({ display_name: "" }))).rejects.toThrow();
    await expect(findOrCreateUser(pool, identity({ subject: "" }))).rejects.toThrow();
    await expect(findOrCreateUser(pool, identity({ provider: "Dev Login" }))).rejects.toThrow();
  });
});

describe("user sessions", () => {
  it("authenticates a fresh session token as its user", async () => {
    const user = await findOrCreateUser(pool, identity());
    const session = await createUserSession(pool, user.id);
    expect(session.session_token).toMatch(/^us_[A-Za-z0-9_-]{43}$/);
    expect(session.expires_at.getTime() - Date.now()).toBeGreaterThan(USER_SESSION_TTL_MS - 5_000);
    expect(await authenticateUser(pool, session.session_token)).toEqual({
      user_id: user.id,
      display_name: "Peter",
    });
  });

  it("stores only the hash of the token", async () => {
    const user = await findOrCreateUser(pool, identity());
    const { session_token } = await createUserSession(pool, user.id);
    const { rows } = await pool.query("SELECT * FROM user_sessions WHERE user_id = $1", [user.id]);
    expect(JSON.stringify(rows)).not.toContain(session_token);
    expect(rows[0].token_hash).toBe(hashToken(session_token));
  });

  it("refuses expired, revoked, unknown and wrongly prefixed tokens identically", async () => {
    const user = await findOrCreateUser(pool, identity());
    const expired = await createUserSession(pool, user.id, { ttlMs: 1000 });
    await pool.query(
      "UPDATE user_sessions SET created_at = created_at - interval '1 hour', expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1",
      [hashToken(expired.session_token)],
    );
    const revoked = await createUserSession(pool, user.id);
    expect(await revokeUserSessions(pool, user.id)).toBeGreaterThanOrEqual(1);
    for (const token of [
      expired.session_token,
      revoked.session_token,
      "us_" + "x".repeat(43),
      "at_" + "x".repeat(43),
      "",
    ]) {
      await rejectsUnauthenticated(authenticateUser(pool, token));
    }
  });

  it("revoking one user's sessions leaves another's alone", async () => {
    const a = await findOrCreateUser(pool, identity());
    const b = await findOrCreateUser(pool, identity());
    await createUserSession(pool, a.id);
    const keep = await createUserSession(pool, b.id);
    await revokeUserSessions(pool, a.id);
    expect((await authenticateUser(pool, keep.session_token)).user_id).toBe(b.id);
  });

  it("revokes only the presented user session", async () => {
    const user = await findOrCreateUser(pool, identity());
    const current = await createUserSession(pool, user.id);
    const other = await createUserSession(pool, user.id);
    expect(await revokeUserSession(pool, current.session_token)).toBe(true);
    expect(await revokeUserSession(pool, current.session_token)).toBe(false);
    await rejectsUnauthenticated(authenticateUser(pool, current.session_token));
    expect((await authenticateUser(pool, other.session_token)).user_id).toBe(user.id);
  });
});

describe("participants.user_id", () => {
  it("must reference an existing user", async () => {
    await pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ('room_u1', 'room-u1', 'n', 'o', 'part_1')`,
    );
    await expect(
      pool.query(
        `INSERT INTO participants (id, room_id, kind, display_name, role, status, user_id)
         VALUES ('part_u1', 'room_u1', 'HUMAN', 'P', 'LEAD', 'ACTIVE', 'usr_missing')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const user = await findOrCreateUser(pool, identity());
    await pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, role, status, user_id)
       VALUES ('part_u1', 'room_u1', 'HUMAN', 'P', 'LEAD', 'ACTIVE', $1)`,
      [user.id],
    );
  });
});
