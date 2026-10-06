import { describe, expect, it } from "vitest";
import {
  AUTHORITIES,
  AUTHORITY_POWERS,
  CAPABILITIES,
  effectiveCapabilities,
  isCapability,
  ROLE_BUNDLES,
  ROLES,
  type Capability,
} from "./bundles.js";

// The expectations below are written out by hand from ARCHITECTURE §6.1 (not derived from
// ROLE_BUNDLES), so a change to the table has to change them too.
const READS: Capability[] = [
  "room.read",
  "participants.read",
  "capabilities.read",
  "approvals.read",
  "messages.read",
  "inbox.read",
  "tasks.read",
  "workspace.read",
  "conflicts.read",
  "sandbox.read",
  "memory.read",
  "decisions.read",
  "tools.read",
  "checkpoints.read",
];
const DEVELOPER_WORK: Capability[] = [
  "sandbox.output",
  "presence.update",
  "messages.send",
  "messages.edit",
  "inbox.ack",
  "tasks.claim",
  "tasks.update",
  "tasks.start",
  "tasks.block",
  "tasks.unblock",
  "tasks.submit",
  "tasks.release",
  "tasks.heartbeat",
  "workspace.write",
  "memory.write",
  "sandbox.exec",
  "decisions.propose",
  "decisions.add_position",
  "decisions.withdraw",
  "room.accept_lead",
];
const EXPECTED: Record<(typeof ROLES)[number], Capability[]> = {
  // "Developer: messages, tasks (claim/update own), workspace read/write, memory read/write,
  //  sandbox exec, decisions propose"
  DEVELOPER: [...READS, ...DEVELOPER_WORK],
  // "Reviewer: read everything, messages, tasks review, decisions propose, memory write"
  REVIEWER: [
    ...READS,
    "sandbox.output",
    "presence.update",
    "messages.send",
    "messages.edit",
    "inbox.ack",
    "tasks.review",
    "decisions.propose",
    "decisions.add_position",
    "decisions.withdraw",
    "memory.write",
    "room.accept_lead",
  ],
  // "Lead: developer bundle + task assign/cancel/reopen, conflict resolve, decision decide,
  //  review, checkpoint create"
  LEAD: [
    ...READS,
    ...DEVELOPER_WORK,
    "tasks.assign",
    "tasks.cancel",
    "tasks.reopen",
    "tasks.review",
    "conflicts.resolve",
    "decisions.decide",
    "checkpoints.create",
    "room.transfer_lead",
  ],
  // "Observer: read everything except sandbox output; no mutations other than presence"
  OBSERVER: [...READS, "presence.update"],
};

const ALL = Object.keys(CAPABILITIES) as Capability[];

describe("role bundles (§6.1)", () => {
  for (const role of ROLES) {
    describe(role, () => {
      it("holds exactly the documented capabilities", () => {
        expect([...ROLE_BUNDLES[role]].sort()).toEqual([...EXPECTED[role]].sort());
      });

      it.each(ALL)("capability %s", (capability) => {
        // Every role × every capability in the catalog, as a MEMBER (no authority powers).
        expect(effectiveCapabilities(role, "MEMBER").has(capability)).toBe(
          EXPECTED[role].includes(capability),
        );
      });
    });
  }

  it("the lead bundle contains the whole developer bundle", () => {
    for (const c of ROLE_BUNDLES.DEVELOPER) expect(ROLE_BUNDLES.LEAD.has(c)).toBe(true);
  });

  it("observers hold no mutating capability except presence", () => {
    for (const c of ALL) {
      if (CAPABILITIES[c].mutating && c !== "presence.update") {
        expect(ROLE_BUNDLES.OBSERVER.has(c), c).toBe(false);
      }
    }
  });

  it("observers can read everything except sandbox output", () => {
    const reads = ALL.filter((c) => !CAPABILITIES[c].mutating);
    expect(reads.filter((c) => !ROLE_BUNDLES.OBSERVER.has(c))).toEqual(["sandbox.output"]);
  });

  it("every role can update presence", () => {
    for (const role of ROLES) expect(ROLE_BUNDLES[role].has("presence.update")).toBe(true);
  });

  it("no role bundle holds an authority power", () => {
    const powers = new Set([...AUTHORITY_POWERS.OWNER, ...AUTHORITY_POWERS.ADMIN]);
    for (const role of ROLES) {
      for (const c of ROLE_BUNDLES[role]) expect(powers.has(c), `${role} ${c}`).toBe(false);
    }
  });
});

describe("authority powers (§6.2)", () => {
  const ADMIN = [
    "room.invite",
    "room.set_lead",
    "participants.set_role",
    "participants.pause",
    "participants.resume",
    "participants.remove",
    "capabilities.grant",
    "capabilities.revoke",
    "approvals.decide",
    "decisions.veto",
    "budgets.set",
    "egress.set",
  ];
  const OWNER_ONLY = [
    "room.freeze",
    "room.resume",
    "room.archive",
    "capabilities.grant_tier3",
    "events.redact",
  ];

  it("members have none", () => {
    expect([...AUTHORITY_POWERS.MEMBER]).toEqual([]);
  });

  it("admins have the shared powers but none of the owner-only ones", () => {
    expect([...AUTHORITY_POWERS.ADMIN].sort()).toEqual([...ADMIN].sort());
    for (const c of OWNER_ONLY) expect(AUTHORITY_POWERS.ADMIN.has(c as Capability), c).toBe(false);
  });

  it("owners have the admin powers plus the owner-only ones (freeze, archive, Tier 3, redact)", () => {
    expect([...AUTHORITY_POWERS.OWNER].sort()).toEqual([...ADMIN, ...OWNER_ONLY].sort());
  });

  it("authority adds to the role's bundle without removing from it", () => {
    for (const role of ROLES) {
      for (const authority of AUTHORITIES) {
        const effective = effectiveCapabilities(role, authority);
        for (const c of ROLE_BUNDLES[role]) expect(effective.has(c)).toBe(true);
        for (const c of AUTHORITY_POWERS[authority]) expect(effective.has(c)).toBe(true);
      }
    }
  });

  it("an owner who is an observer still has owner powers (authority is separate from role)", () => {
    const effective = effectiveCapabilities("OBSERVER", "OWNER");
    expect(effective.has("room.archive")).toBe(true);
    expect(effective.has("workspace.write")).toBe(false);
  });
});

describe("catalog", () => {
  it("isCapability only accepts own, known capabilities", () => {
    expect(isCapability("workspace.write")).toBe(true);
    expect(isCapability("workspace.explode")).toBe(false);
    expect(isCapability("toString")).toBe(false);
    expect(isCapability("__proto__")).toBe(false);
    expect(isCapability("")).toBe(false);
  });

  it("every bundle and power entry is in the catalog", () => {
    for (const set of [...Object.values(ROLE_BUNDLES), ...Object.values(AUTHORITY_POWERS)]) {
      for (const c of set) expect(isCapability(c)).toBe(true);
    }
  });
});
