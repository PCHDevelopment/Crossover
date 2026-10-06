/**
 * Capabilities and who holds them by default (ARCHITECTURE §6.1, §6.2), as data.
 *
 * A capability is `<resource>.<action>`. A participant's effective capabilities are the
 * bundle for their project **role** plus the powers of their **authority**; explicit grants
 * and revocations (§21.1, T210) come on top later. Anything not in the catalog is denied.
 *
 * Capabilities §6.1 / §6.2 don't name are left out of every bundle on purpose (fail closed):
 * whoever builds the command adds them to the right bundle, in review. Examples: creating
 * tasks, escalating or abandoning conflicts, and the participant-management powers an agent
 * lead has within the §6.3 limits.
 */
export const CAPABILITIES = {
  // ---- reads (tier 0)
  "room.read": { mutating: false },
  "participants.read": { mutating: false },
  "capabilities.read": { mutating: false },
  "approvals.read": { mutating: false },
  "messages.read": { mutating: false },
  "inbox.read": { mutating: false },
  "tasks.read": { mutating: false },
  "workspace.read": { mutating: false },
  "conflicts.read": { mutating: false },
  "sandbox.read": { mutating: false },
  /** Output of sandbox commands. Observers can't see it (§6.1). */
  "sandbox.output": { mutating: false },
  "memory.read": { mutating: false },
  "decisions.read": { mutating: false },
  "tools.read": { mutating: false },
  "checkpoints.read": { mutating: false },

  // ---- presence: the one mutation every role has (ephemeral, self only)
  "presence.update": { mutating: true },

  // ---- developer work (tier 1)
  "messages.send": { mutating: true },
  "messages.edit": { mutating: true },
  "inbox.ack": { mutating: true },
  "tasks.create": { mutating: true },
  "tasks.claim": { mutating: true },
  "tasks.update": { mutating: true },
  "tasks.start": { mutating: true },
  "tasks.block": { mutating: true },
  "tasks.unblock": { mutating: true },
  "tasks.submit": { mutating: true },
  "tasks.release": { mutating: true },
  "tasks.heartbeat": { mutating: true },
  "workspace.write": { mutating: true },
  "memory.write": { mutating: true },
  "sandbox.exec": { mutating: true },
  "decisions.propose": { mutating: true },
  "decisions.add_position": { mutating: true },
  "decisions.withdraw": { mutating: true },
  "room.accept_lead": { mutating: true },

  // ---- reviewer
  "tasks.review": { mutating: true },

  // ---- lead
  "tasks.assign": { mutating: true },
  "tasks.cancel": { mutating: true },
  "tasks.reopen": { mutating: true },
  "conflicts.resolve": { mutating: true },
  "decisions.decide": { mutating: true },
  "checkpoints.create": { mutating: true },
  "room.transfer_lead": { mutating: true },

  // ---- authority powers (§6.2)
  "room.invite": { mutating: true },
  "room.set_lead": { mutating: true },
  "participants.set_role": { mutating: true },
  "participants.pause": { mutating: true },
  "participants.resume": { mutating: true },
  "participants.remove": { mutating: true },
  "capabilities.grant": { mutating: true },
  "capabilities.revoke": { mutating: true },
  "approvals.decide": { mutating: true },
  "decisions.veto": { mutating: true },
  "budgets.set": { mutating: true },
  "egress.set": { mutating: true },
  // owner only
  "room.freeze": { mutating: true },
  "room.resume": { mutating: true },
  "room.archive": { mutating: true },
  /** Granting Tier 3 capabilities (§21.2): owner only. */
  "capabilities.grant_tier3": { mutating: true },
  "events.redact": { mutating: true },
} as const satisfies Record<string, { mutating: boolean }>;

export type Capability = keyof typeof CAPABILITIES;

export const ROLES = ["LEAD", "DEVELOPER", "REVIEWER", "OBSERVER"] as const;
export type Role = (typeof ROLES)[number];

export const AUTHORITIES = ["OWNER", "ADMIN", "MEMBER"] as const;
export type Authority = (typeof AUTHORITIES)[number];

export function isCapability(value: string): value is Capability {
  return Object.hasOwn(CAPABILITIES, value);
}

const READS = [
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
] as const satisfies readonly Capability[];

const DEVELOPER = [
  ...READS,
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
] as const satisfies readonly Capability[];

const REVIEWER = [
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
] as const satisfies readonly Capability[];

const LEAD = [
  ...DEVELOPER,
  "tasks.assign",
  "tasks.cancel",
  "tasks.reopen",
  "tasks.review",
  "conflicts.resolve",
  "decisions.decide",
  "checkpoints.create",
  "room.transfer_lead",
  // The commands (T211, T212) enforce the limits: an agent lead can't touch humans, and only
  // a human can un-pause what a human paused (§6.3, §22.1).
  "participants.pause",
  "participants.resume",
  "participants.set_role",
] as const satisfies readonly Capability[];

/**
 * Read everything except sandbox output; no mutations to shared project state other than
 * presence (§6.1). `inbox.ack` only changes the observer's own inbox.
 */
const OBSERVER = [
  ...READS,
  "presence.update",
  "inbox.ack",
] as const satisfies readonly Capability[];

/** Default capabilities by project role (§6.1). */
export const ROLE_BUNDLES: Readonly<Record<Role, ReadonlySet<Capability>>> = {
  LEAD: new Set<Capability>(LEAD),
  DEVELOPER: new Set<Capability>(DEVELOPER),
  REVIEWER: new Set<Capability>(REVIEWER),
  OBSERVER: new Set<Capability>(OBSERVER),
};

const ADMIN_POWERS = [
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
] as const satisfies readonly Capability[];

const OWNER_POWERS = [
  ...ADMIN_POWERS,
  "room.freeze",
  "room.resume",
  "room.archive",
  "capabilities.grant_tier3",
  "events.redact",
] as const satisfies readonly Capability[];

/**
 * What each authority level can do on top of its role's bundle (§6.2). Only humans can be
 * owner or admin (D8, enforced by the database). Owner-only: freeze/resume/archive, Tier 3
 * grants, and redaction.
 */
export const AUTHORITY_POWERS: Readonly<Record<Authority, ReadonlySet<Capability>>> = {
  OWNER: new Set<Capability>(OWNER_POWERS),
  ADMIN: new Set<Capability>(ADMIN_POWERS),
  MEMBER: new Set<Capability>(),
};

/** Role bundle plus authority powers. */
export function effectiveCapabilities(role: Role, authority: Authority): ReadonlySet<Capability> {
  return new Set<Capability>([...ROLE_BUNDLES[role], ...AUTHORITY_POWERS[authority]]);
}

/**
 * Is `base` (`<resource>.<action>`, no scope) a power that comes with owner or admin
 * authority (§6.2)? Such capabilities can't be granted, revoked or put in an invite: an agent
 * must never gain governing powers (D8), and an owner must not be locked out.
 */
export function isAuthorityPower(base: string): boolean {
  return isCapability(base) && AUTHORITY_POWERS.OWNER.has(base);
}
