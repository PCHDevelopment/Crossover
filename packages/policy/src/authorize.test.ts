import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { CrossoverError } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorize, type PolicyPrincipal } from "./authorize.js";
import {
  AUTHORITIES,
  CAPABILITIES,
  effectiveCapabilities,
  ROLES,
  type Capability,
} from "./bundles.js";

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

interface Fixture {
  room: string;
  principal: PolicyPrincipal;
}

async function participant(
  fields: { kind?: string; authority?: string; role?: string; status?: string } = {},
): Promise<Fixture> {
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
  return { room, principal: { participant_id: id, room_id: room } };
}

const check = (f: Fixture, action: string, extra: Record<string, unknown> = {}) =>
  authorize(
    f.principal,
    action,
    { room_id: f.room, ...extra },
    { method: "m", params: {}, client: pool },
  );

const ALL = Object.keys(CAPABILITIES) as Capability[];

describe("authorize: role × capability against the database", () => {
  for (const role of ROLES) {
    it(`${role}: every catalog capability is allowed or denied exactly as the bundle says`, async () => {
      const f = await participant({ role });
      const bundle = effectiveCapabilities(role, "MEMBER");
      for (const capability of ALL) {
        const outcome = await check(f, capability).then(
          () => "allow",
          (e: unknown) => e,
        );
        if (bundle.has(capability)) {
          expect(outcome, `${role} ${capability}`).toBe("allow");
        } else {
          expect(outcome, `${role} ${capability}`).toBeInstanceOf(CrossoverError);
          expect(outcome, `${role} ${capability}`).toMatchObject({
            code: "FORBIDDEN",
            details: { missing_capability: capability, role, authority: "MEMBER" },
          });
        }
      }
    });
  }

  it("observers cannot mutate shared state: only presence and their own inbox", async () => {
    const f = await participant({ role: "OBSERVER" });
    for (const capability of ALL.filter((c) => CAPABILITIES[c].mutating)) {
      const allowed = await check(f, capability).then(
        () => true,
        () => false,
      );
      expect(allowed, capability).toBe(
        capability === "presence.update" || capability === "inbox.ack",
      );
    }
  });

  // Measured (T1529): idle 2718 ms, 3x load 5092 ms; budget 7x.
  it("every authority × role combination: allowed iff role bundle or authority grants it", async () => {
    for (const authority of AUTHORITIES) {
      for (const role of ROLES) {
        const f = await participant({ authority, role });
        const effective = effectiveCapabilities(role, authority);
        for (const capability of ALL) {
          const allowed = await check(f, capability).then(
            () => true,
            () => false,
          );
          expect(allowed, `${authority}/${role} ${capability}`).toBe(effective.has(capability));
        }
      }
    }
  }, 40_000);
});

describe("authorize: the denial", () => {
  it("is FORBIDDEN with details.missing_capability naming the requested action", async () => {
    const f = await participant({ role: "OBSERVER" });
    const err = await check(f, "workspace.write").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrossoverError);
    expect(err).toMatchObject({
      code: "FORBIDDEN",
      retryable: false,
      details: { missing_capability: "workspace.write" },
    });
  });

  it("keeps a scope in missing_capability", async () => {
    const f = await participant({ role: "OBSERVER" });
    await expect(check(f, "workspace.write:src/a.ts")).rejects.toMatchObject({
      details: { missing_capability: "workspace.write:src/a.ts" },
    });
  });

  it("denies unknown and malformed capabilities for everyone, owners included", async () => {
    const owner = await participant({ authority: "OWNER", role: "LEAD" });
    for (const action of [
      "",
      "workspace",
      "workspace.explode",
      "toString",
      "__proto__",
      ":scope",
      "*",
    ]) {
      await expect(check(owner, action), action).rejects.toMatchObject({
        code: "FORBIDDEN",
        details: { missing_capability: action, reason: "unknown_capability" },
      });
    }
    await expect(check(owner, undefined as unknown as string)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("authorize: scopes", () => {
  it("a role bundle covers every scope of a capability it holds", async () => {
    const dev = await participant({ role: "DEVELOPER" });
    await check(dev, "workspace.write:src/api/x.ts");
    await check(dev, "workspace.write:docs/**");
    await check(dev, "workspace.read:anything:at:all");
  });

  it("a scope doesn't grant a capability the participant lacks", async () => {
    const reviewer = await participant({ role: "REVIEWER" });
    await expect(check(reviewer, "workspace.write:src/a.ts")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("authorize: the principal is a snapshot, the database wins", () => {
  it("uses the participant's current role, not the one at authentication time", async () => {
    const f = await participant({ role: "DEVELOPER" });
    await check(f, "workspace.write");
    await pool.query("UPDATE participants SET role = 'OBSERVER' WHERE id = $1", [
      f.principal.participant_id,
    ]);
    await expect(check(f, "workspace.write")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await pool.query("UPDATE participants SET role = 'LEAD' WHERE id = $1", [
      f.principal.participant_id,
    ]);
    await check(f, "tasks.assign");
  });

  it("uses the participant's current authority", async () => {
    const f = await participant({ authority: "ADMIN" });
    await check(f, "room.invite");
    await pool.query("UPDATE participants SET authority = 'MEMBER' WHERE id = $1", [
      f.principal.participant_id,
    ]);
    await expect(check(f, "room.invite")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ignores any extra role/authority claims on the principal object", async () => {
    const f = await participant({ role: "OBSERVER", authority: "MEMBER" });
    const forged = {
      ...f.principal,
      role: "LEAD",
      authority: "OWNER",
    } as PolicyPrincipal;
    await expect(
      authorize(
        forged,
        "room.archive",
        { room_id: f.room },
        { method: "m", params: {}, client: pool },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("authorize: who may act in which room", () => {
  it("rejects a resource in another room than the principal's", async () => {
    const [a, b] = [await participant(), await participant()];
    await expect(
      authorize(
        a.principal,
        "workspace.read",
        { room_id: b.room },
        { method: "m", params: {}, client: pool },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", details: { reason: "room_mismatch" } });
  });

  it("rejects a principal that isn't a participant of its room", async () => {
    const f = await participant();
    const ghost = { participant_id: "part_ghost", room_id: f.room };
    await expect(
      authorize(
        ghost,
        "workspace.read",
        { room_id: f.room },
        { method: "m", params: {}, client: pool },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN", details: { reason: "not_a_participant" } });
  });

  it("rejects removed and invited participants", async () => {
    for (const status of ["REMOVED", "INVITED"]) {
      const f = await participant({ status });
      await expect(check(f, "room.read"), status).rejects.toMatchObject({
        code: "FORBIDDEN",
        details: { reason: `participant_${status.toLowerCase()}` },
      });
    }
  });

  it("answers PARTICIPANT_PAUSED to a paused participant for every action, reads included", async () => {
    const f = await participant({ status: "PAUSED", authority: "OWNER", role: "LEAD" });
    for (const action of ["room.read", "workspace.write", "room.archive", "workspace.explode"]) {
      const err = await check(f, action).catch((e: unknown) => e);
      expect(err, action).toBeInstanceOf(CrossoverError);
      expect(err, action).toMatchObject({ code: "PARTICIPANT_PAUSED" });
    }
  });

  it("works on a transaction client and sees uncommitted changes in it", async () => {
    const f = await participant({ role: "DEVELOPER" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE participants SET role = 'OBSERVER' WHERE id = $1", [
        f.principal.participant_id,
      ]);
      await expect(
        authorize(
          f.principal,
          "workspace.write",
          { room_id: f.room },
          { method: "m", params: {}, client },
        ),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    await check(f, "workspace.write"); // the rollback restored the developer role
  });
});
