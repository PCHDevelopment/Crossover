import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authorize, type PolicyPrincipal } from "./authorize.js";

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
  me: string;
  principal: PolicyPrincipal;
}

async function fixture(role = "DEVELOPER", room?: string): Promise<Fixture> {
  const roomId = room ?? `room_${++n}`;
  const id = `part_${++n}`;
  if (!room) {
    await pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', $2)`,
      [roomId, id],
    );
  }
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'AGENT', 'a', 'MEMBER', $3, 'ACTIVE')`,
    [id, roomId, role],
  );
  return { room: roomId, me: id, principal: { participant_id: id, room_id: roomId } };
}

async function addGrant(
  f: Fixture,
  capability: string,
  options: {
    effect?: "GRANT" | "DENY";
    requires_approval?: boolean;
    expires?: string; // SQL interval from now
    ended?: boolean;
    participant?: string;
  } = {},
) {
  const expires = options.expires ? `clock_timestamp() + interval '${options.expires}'` : "NULL";
  await pool.query(
    `INSERT INTO capability_grants
       (id, room_id, participant_id, effect, capability, requires_approval, created_by, created_at, expires_at, ended_at, ended_by)
     VALUES ($1, $2, $3, $4, $5, $6, $3, clock_timestamp() - interval '1 hour', ${expires},
             ${options.ended ? "clock_timestamp()" : "NULL"}, ${options.ended ? "$3" : "NULL"})`,
    [
      `grant_${++n}`,
      f.room,
      options.participant ?? f.me,
      options.effect ?? "GRANT",
      capability,
      options.requires_approval ?? false,
    ],
  );
}

const check = (f: Fixture, action: string) =>
  authorize(f.principal, action, { room_id: f.room }, { method: "x", params: {}, client: pool });

/** The way workspace.apply / workspace.read call it: path in the resource, not the action. */
const checkPath = (f: Fixture, action: string, path: string) =>
  authorize(
    f.principal,
    action,
    { room_id: f.room, path },
    { method: "x", params: {}, client: pool },
  );

const outcomeAt = (f: Fixture, action: string, path: string) =>
  checkPath(f, action, path).then(
    () => "allowed",
    (e: { code?: string; details?: { reason?: string } }) =>
      e.code === "FORBIDDEN" && e.details?.reason ? `FORBIDDEN:${e.details.reason}` : e.code,
  );

const outcome = (f: Fixture, action: string) =>
  check(f, action).then(
    () => "allowed",
    (e: { code?: string; details?: { reason?: string } }) =>
      e.code === "FORBIDDEN" && e.details?.reason ? `FORBIDDEN:${e.details.reason}` : e.code,
  );

describe("grants in authorize()", () => {
  it("allows a granted capability the role bundle lacks, and only that one", async () => {
    const f = await fixture("DEVELOPER");
    expect(await outcome(f, "github.create_pull_request")).toBe("FORBIDDEN:unknown_capability");
    await addGrant(f, "github.create_pull_request");
    expect(await outcome(f, "github.create_pull_request")).toBe("allowed");
    expect(await outcome(f, "slack.post_message")).toBe("FORBIDDEN:unknown_capability");
  });

  it("grants a catalog capability a role lacks (REVIEWER + workspace.write)", async () => {
    const f = await fixture("REVIEWER");
    expect(await outcome(f, "workspace.write")).toBe("FORBIDDEN");
    await addGrant(f, "workspace.write");
    expect(await outcome(f, "workspace.write")).toBe("allowed");
    expect(await outcome(f, "workspace.write:src/a.ts")).toBe("allowed"); // unscoped covers all
  });

  it("applies scope: a scoped grant covers matching scopes only, and not the unscoped capability", async () => {
    const f = await fixture("REVIEWER");
    await addGrant(f, "workspace.write:src/**");
    expect(await outcome(f, "workspace.write:src/a/b.ts")).toBe("allowed");
    expect(await outcome(f, "workspace.write:docs/a.md")).toBe("FORBIDDEN");
    expect(await outcome(f, "workspace.write")).toBe("FORBIDDEN");
    expect(await outcome(f, "workspace.write:src/../etc")).toBe("FORBIDDEN");
  });

  it("ignores expired and ended grants", async () => {
    const f = await fixture("REVIEWER");
    await addGrant(f, "browser.navigate", { expires: "-1 minute" });
    await addGrant(f, "slack.post_message", { ended: true });
    expect(await outcome(f, "browser.navigate")).toBe("FORBIDDEN:unknown_capability");
    expect(await outcome(f, "slack.post_message")).toBe("FORBIDDEN:unknown_capability");
    await addGrant(f, "github.create_pull_request", { expires: "1 hour" });
    expect(await outcome(f, "github.create_pull_request")).toBe("allowed");
  });

  it("stops allowing a grant the moment it ends or expires (next call)", async () => {
    const f = await fixture("DEVELOPER");
    await addGrant(f, "github.create_pull_request");
    expect(await outcome(f, "github.create_pull_request")).toBe("allowed");
    await pool.query(
      "UPDATE capability_grants SET ended_at = clock_timestamp(), ended_by = $1 WHERE participant_id = $1",
      [f.me],
    );
    expect(await outcome(f, "github.create_pull_request")).toBe("FORBIDDEN:unknown_capability");

    const g = await fixture("DEVELOPER");
    await addGrant(g, "browser.navigate", { expires: "1 hour" });
    expect(await outcome(g, "browser.navigate")).toBe("allowed");
    await pool.query(
      "UPDATE capability_grants SET created_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 second' WHERE participant_id = $1",
      [g.me],
    );
    expect(await outcome(g, "browser.navigate")).toBe("FORBIDDEN:unknown_capability");
  });

  it("a DENY removes a capability the role bundle gives", async () => {
    const f = await fixture("DEVELOPER");
    expect(await outcome(f, "sandbox.exec")).toBe("allowed");
    await addGrant(f, "sandbox.exec", { effect: "DENY" });
    expect(await outcome(f, "sandbox.exec")).toBe("FORBIDDEN:revoked");
    expect(await outcome(f, "workspace.write")).toBe("allowed"); // others untouched
  });

  it("a DENY wins over a grant of the same capability", async () => {
    const f = await fixture("DEVELOPER");
    await addGrant(f, "sandbox.exec");
    await addGrant(f, "sandbox.exec", { effect: "DENY" });
    expect(await outcome(f, "sandbox.exec")).toBe("FORBIDDEN:revoked");
  });

  it("a scoped DENY takes away only the matching scopes", async () => {
    const f = await fixture("DEVELOPER");
    await addGrant(f, "workspace.write:secrets/**", { effect: "DENY" });
    expect(await outcome(f, "workspace.write:src/a.ts")).toBe("allowed");
    expect(await outcome(f, "workspace.write:secrets/key.pem")).toBe("FORBIDDEN:revoked");
    expect(await outcome(f, "workspace.write")).toBe("allowed");
  });

  it("an approval-gated grant fails closed with APPROVAL_REQUIRED, even over the role bundle", async () => {
    const f = await fixture("DEVELOPER");
    await addGrant(f, "github.create_pull_request", { requires_approval: true });
    expect(await outcome(f, "github.create_pull_request")).toBe("APPROVAL_REQUIRED");
    await addGrant(f, "sandbox.exec", { requires_approval: true }); // gating a bundle capability
    expect(await outcome(f, "sandbox.exec")).toBe("APPROVAL_REQUIRED");
    expect(await outcome(f, "workspace.write")).toBe("allowed");
  });

  it("an ungated grant next to a gated one allows the action", async () => {
    const f = await fixture("REVIEWER");
    await addGrant(f, "workspace.write:src/**", { requires_approval: true });
    await addGrant(f, "workspace.write");
    expect(await outcome(f, "workspace.write:src/a.ts")).toBe("allowed");
  });

  it("only counts the participant's own grants, in their own room", async () => {
    const a = await fixture("DEVELOPER");
    const b = await fixture("DEVELOPER", a.room); // same room, other participant
    const c = await fixture("DEVELOPER"); // other room
    await addGrant(a, "github.create_pull_request");
    expect(await outcome(b, "github.create_pull_request")).toBe("FORBIDDEN:unknown_capability");
    expect(await outcome(c, "github.create_pull_request")).toBe("FORBIDDEN:unknown_capability");
    // A grant row for a participant of another room can't be inserted at all.
    await expect(addGrant(a, "x.y", { participant: c.me })).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("an unknown capability stays forbidden unless a grant names it", async () => {
    const f = await fixture("DEVELOPER");
    expect(await outcome(f, "nothing.here")).toBe("FORBIDDEN:unknown_capability");
    await addGrant(f, "nothing.here");
    expect(await outcome(f, "nothing.here")).toBe("allowed");
  });
});

describe("grants and denies against resource.path (the way workspace commands authorize)", () => {
  it("a scoped DENY applies to a path named in the resource", async () => {
    const f = await fixture("DEVELOPER");
    await addGrant(f, "workspace.write:secrets/**", { effect: "DENY" });
    expect(await outcomeAt(f, "workspace.write", "secrets/key.pem")).toBe("FORBIDDEN:revoked");
    expect(await outcomeAt(f, "workspace.write", "secrets/.env")).toBe("FORBIDDEN:revoked");
    expect(await outcomeAt(f, "workspace.write", "secrets/a/b/c")).toBe("FORBIDDEN:revoked");
    expect(await outcomeAt(f, "workspace.write", "src/a.ts")).toBe("allowed");
    expect(await outcomeAt(f, "workspace.read", "secrets/key.pem")).toBe("allowed"); // other action
    expect(await outcome(f, "workspace.write")).toBe("allowed"); // no path: coarse check unchanged
  });

  it("a scoped GRANT covers matching paths and only those", async () => {
    const f = await fixture("REVIEWER");
    await addGrant(f, "workspace.write:src/**");
    expect(await outcomeAt(f, "workspace.write", "src/a/b.ts")).toBe("allowed");
    expect(await outcomeAt(f, "workspace.write", "docs/a.md")).toBe("FORBIDDEN");
    expect(await outcomeAt(f, "workspace.write", "src")).toBe("FORBIDDEN");
  });

  it("an unscoped grant or deny covers every path", async () => {
    const f = await fixture("REVIEWER");
    await addGrant(f, "workspace.write");
    expect(await outcomeAt(f, "workspace.write", "any/where.txt")).toBe("allowed");
    await addGrant(f, "workspace.write", { effect: "DENY" });
    expect(await outcomeAt(f, "workspace.write", "any/where.txt")).toBe("FORBIDDEN:revoked");
  });

  it("file names with spaces and unicode are matched, not rejected", async () => {
    const f = await fixture("DEVELOPER");
    await addGrant(f, "workspace.write:docs/**", { effect: "DENY" });
    expect(await outcomeAt(f, "workspace.write", "docs/My File ü.md")).toBe("FORBIDDEN:revoked");
    expect(await outcomeAt(f, "workspace.write", "src/My File ü.md")).toBe("allowed");
  });

  it.each(["src/../secrets/k", "/etc/passwd", "a//b", "./a", "a/./b", "src\\a", "a\u0000b"])(
    "an unsafe path (%j) fails closed",
    async (path) => {
      const f = await fixture("DEVELOPER");
      expect(await outcomeAt(f, "workspace.write", path)).toBe("FORBIDDEN:invalid_path");
    },
  );

  it("a gated scoped grant makes matching paths wait for approval", async () => {
    const f = await fixture("REVIEWER");
    await addGrant(f, "workspace.write:deploy/**", { requires_approval: true });
    expect(await outcomeAt(f, "workspace.write", "deploy/prod.yml")).toBe("APPROVAL_REQUIRED");
    expect(await outcomeAt(f, "workspace.write", "src/a.ts")).toBe("FORBIDDEN");
  });

  it("an explicit scope in the action wins over a path in the resource", async () => {
    const f = await fixture("DEVELOPER");
    await addGrant(f, "workspace.write:secrets/**", { effect: "DENY" });
    expect(await outcomeAt(f, "workspace.write:src/a.ts", "secrets/k")).toBe("allowed");
  });

  it("ignores resource.path for resources that aren't path-scoped", async () => {
    const f = await fixture("DEVELOPER");
    await addGrant(f, "tasks.create:x/**", { effect: "DENY" });
    expect(await outcomeAt(f, "tasks.create", "x/y")).toBe("allowed");
  });
});

describe("the gate of a per-path command (T218)", () => {
  const gate = (f: Fixture, action: string, perPath: boolean | undefined) =>
    authorize(
      f.principal,
      action,
      { room_id: f.room },
      { method: "x", params: {}, client: pool, ...(perPath === undefined ? {} : { perPath }) },
    ).then(
      () => "allowed",
      (e: { code?: string }) => e.code,
    );

  it("lets in a holder of an ungated scoped grant, but only for a per-path command", async () => {
    const f = await fixture("REVIEWER");
    await addGrant(f, "workspace.write:docs/**");
    expect(await gate(f, "workspace.write", true)).toBe("allowed");
    expect(await gate(f, "workspace.write", false)).toBe("FORBIDDEN");
    expect(await gate(f, "workspace.write", undefined)).toBe("FORBIDDEN");
  });

  it("then leaves the decision to the per-path checks", async () => {
    const f = await fixture("REVIEWER");
    await addGrant(f, "workspace.write:docs/**");
    expect(await outcomeAt(f, "workspace.write", "docs/a.md")).toBe("allowed");
    expect(await outcomeAt(f, "workspace.write", "src/a.ts")).toBe("FORBIDDEN");
  });

  it("needs a live, ungated grant of that capability", async () => {
    const f = await fixture("REVIEWER");
    expect(await gate(f, "workspace.write", true)).toBe("FORBIDDEN"); // nothing
    await addGrant(f, "workspace.read:docs/**"); // another capability
    await addGrant(f, "workspace.write:docs/**", { requires_approval: true }); // gated
    await addGrant(f, "workspace.write:old/**", { expires: "-1 minute" }); // expired
    await addGrant(f, "workspace.write:ended/**", { ended: true }); // ended
    expect(await gate(f, "workspace.write", true)).toBe("FORBIDDEN");
    await addGrant(f, "workspace.write:src/**");
    expect(await gate(f, "workspace.write", true)).toBe("allowed");
  });

  it("is still refused when the whole capability was revoked", async () => {
    const f = await fixture("REVIEWER");
    await addGrant(f, "workspace.write:docs/**");
    await addGrant(f, "workspace.write", { effect: "DENY" });
    expect(await gate(f, "workspace.write", true)).toBe("FORBIDDEN");
  });

  it("doesn't turn a path check into a gate: a path in the resource ignores the flag", async () => {
    const f = await fixture("REVIEWER");
    await addGrant(f, "workspace.write:docs/**");
    const res = await authorize(
      f.principal,
      "workspace.write",
      { room_id: f.room, path: "src/a.ts" },
      { method: "x", params: {}, client: pool, perPath: true },
    ).then(
      () => "allowed",
      (e: { code?: string }) => e.code,
    );
    expect(res).toBe("FORBIDDEN");
  });
});

describe("the workspace root", () => {
  it("is a valid thing to check: an unscoped grant or deny covers it, a scoped one doesn't", async () => {
    const f = await fixture("DEVELOPER");
    expect(await outcomeAt(f, "workspace.read", "")).toBe("allowed"); // bundle
    await addGrant(f, "workspace.read:secrets/**", { effect: "DENY" });
    expect(await outcomeAt(f, "workspace.read", "")).toBe("allowed");
    await addGrant(f, "workspace.read", { effect: "DENY" });
    expect(await outcomeAt(f, "workspace.read", "")).toBe("FORBIDDEN:revoked");
  });
});

describe("capability_grants constraints", () => {
  it("allows one live row per participant, effect and capability, but keeps history", async () => {
    const f = await fixture("DEVELOPER");
    await addGrant(f, "browser.navigate");
    await expect(addGrant(f, "browser.navigate")).rejects.toMatchObject({ code: "23505" });
    await pool.query(
      "UPDATE capability_grants SET ended_at = clock_timestamp(), ended_by = $1 WHERE participant_id = $1",
      [f.me],
    );
    await addGrant(f, "browser.navigate"); // fine once the old one has ended
    await addGrant(f, "browser.navigate", { effect: "DENY" }); // other effect is independent
  });

  it("only GRANT rows can require approval, and an expiry must follow creation", async () => {
    const f = await fixture("DEVELOPER");
    await expect(
      addGrant(f, "browser.navigate", { effect: "DENY", requires_approval: true }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, created_by, created_at, expires_at)
         VALUES ('grant_bad', $1, $2, 'GRANT', 'a.b', $2, now(), now() - interval '1 day')`,
        [f.room, f.me],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
