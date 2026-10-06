import { describe, expect, it } from "vitest";
import {
  AUTHORITIES,
  AUTHORITY_POWERS,
  CAPABILITIES,
  effectiveCapabilities,
  isAuthorityPower,
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
  "tasks.create",
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
    // within the §6.3 / §22.1 limits, which the commands enforce
    "participants.pause",
    "participants.resume",
    "participants.set_role",
  ],
  // "Observer: read everything except sandbox output; no mutations other than presence",
  // where "mutations" means shared project state: acking their own inbox is allowed.
  OBSERVER: [...READS, "presence.update", "inbox.ack"],
};

const ALL = Object.keys(CAPABILITIES) as Capability[];

/** The only mutations an observer has: presence, and acknowledging their own inbox. */
const OBSERVER_OWN_STATE: Capability[] = ["presence.update", "inbox.ack"];

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

  it("observers hold no mutating capability except presence and their own inbox", () => {
    for (const c of ALL) {
      if (CAPABILITIES[c].mutating && !OBSERVER_OWN_STATE.includes(c)) {
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

  it("no role bundle holds an authority power, except the lead's participant management", () => {
    // Leads may pause, resume and set roles (T211/T212 enforce the §6.3 limits). Nobody gets
    // an owner-only power from a role.
    const leadOnly = ["participants.pause", "participants.resume", "participants.set_role"];
    const powers = new Set([...AUTHORITY_POWERS.OWNER, ...AUTHORITY_POWERS.ADMIN]);
    for (const role of ROLES) {
      for (const c of ROLE_BUNDLES[role]) {
        const allowed = role === "LEAD" && leadOnly.includes(c);
        expect(powers.has(c) && !allowed, `${role} ${c}`).toBe(false);
      }
    }
    for (const c of ["room.freeze", "room.archive", "capabilities.grant_tier3", "events.redact"]) {
      for (const role of ROLES)
        expect(ROLE_BUNDLES[role].has(c as Capability), `${role} ${c}`).toBe(false);
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

  it("owners and admins can assign, cancel and reopen tasks whatever their role (§8.2); members can't unless their role does", () => {
    for (const authority of ["OWNER", "ADMIN"] as const) {
      for (const role of ROLES) {
        const effective = effectiveCapabilities(role, authority);
        for (const c of ["tasks.assign", "tasks.cancel", "tasks.reopen"] as const) {
          expect(effective.has(c), `${authority}/${role} ${c}`).toBe(true);
        }
      }
    }
    expect(effectiveCapabilities("DEVELOPER", "MEMBER").has("tasks.assign")).toBe(false);
    expect(effectiveCapabilities("LEAD", "MEMBER").has("tasks.assign")).toBe(true);
    // They stay grantable: not an authority power.
    expect(isAuthorityPower("tasks.assign")).toBe(false);
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
