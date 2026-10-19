import { z } from "zod";
import { isId, type Id } from "./ids.js";

/**
 * Every Room Protocol method in ARCHITECTURE §16.1, with whether it mutates state.
 * A mutating method needs an `idempotency_key` in its command envelope (§16.2).
 *
 * Classification notes:
 * - `presence.*` are ephemeral last-write-wins updates kept in Redis, not ledger writes,
 *   and `tasks.heartbeat` only renews a lease; none of them needs a dedupe key.
 * - Subscriptions, listings, reads and diffs are read-only.
 */
export const METHODS = {
  /** Not in the §16.1 list: creates a room, so it has no room to be scoped to (T202). */
  "room.create": { mutating: true },
  "room.get_state": { mutating: false },
  "room.digest": { mutating: false },
  "room.events.subscribe": { mutating: false },
  "room.events.list": { mutating: false },
  "room.set_egress_allowlist": { mutating: true },
  "room.set_a2a_allowlist": { mutating: true },
  "room.set_protected_paths": { mutating: true },
  "room.set_health": { mutating: true },
  "budgets.get": { mutating: false },
  "budgets.set": { mutating: true },
  "events.redact": { mutating: true },
  "room.set_lead": { mutating: true },
  "room.transfer_lead": { mutating: true },
  "room.accept_lead": { mutating: true },
  "room.freeze": { mutating: true },
  "room.resume": { mutating: true },
  "room.archive": { mutating: true },
  "rooms.set_retention": { mutating: true },
  "rooms.unarchive": { mutating: true },
  "room.invite": { mutating: true },

  "participants.list": { mutating: false },
  "participants.get": { mutating: false },
  "participants.set_role": { mutating: true },
  "participants.update_manifest": { mutating: true },
  "participants.wake_secret": { mutating: false },
  "participants.pause": { mutating: true },
  "participants.resume": { mutating: true },
  "participants.remove": { mutating: true },
  "presence.update": { mutating: false },
  "presence.set_intent": { mutating: false },
  "presence.clear_intent": { mutating: false },
  "presence.list_intents": { mutating: false },
  "presence.list": { mutating: false },

  "capabilities.list": { mutating: false },
  "capabilities.grant": { mutating: true },
  "capabilities.revoke": { mutating: true },
  "approvals.list": { mutating: false },
  "approvals.decide": { mutating: true },
  "approvals.withdraw": { mutating: true },

  "messages.list": { mutating: false },
  "messages.send": { mutating: true },
  "messages.edit": { mutating: true },

  "inbox.list": { mutating: false },
  "inbox.ack": { mutating: true },

  "tasks.list": { mutating: false },
  "tasks.get": { mutating: false },
  "tasks.create": { mutating: true },
  "tasks.update": { mutating: true },
  "tasks.claim": { mutating: true },
  "tasks.assign": { mutating: true },
  "tasks.release": { mutating: true },
  "tasks.start": { mutating: true },
  "tasks.block": { mutating: true },
  "tasks.unblock": { mutating: true },
  "tasks.submit": { mutating: true },
  "tasks.review": { mutating: true },
  "tasks.reopen": { mutating: true },
  "tasks.cancel": { mutating: true },
  "tasks.heartbeat": { mutating: false },

  "workspace.list": { mutating: false },
  "workspace.read": { mutating: false },
  "workspace.search": { mutating: false },
  "workspace.diff": { mutating: false },
  "workspace.history": { mutating: false },
  "workspace.blame": { mutating: false },
  "workspace.apply_changeset": { mutating: true },
  "workspace.changeset.get": { mutating: false },
  "workspace.changeset.decide_hold": { mutating: true },
  "workspace.health.get": { mutating: false },

  "conflicts.list": { mutating: false },
  "conflicts.get": { mutating: false },
  "conflicts.escalate": { mutating: true },
  "conflicts.abandon": { mutating: true },

  "sandbox.status": { mutating: false },
  "sandbox.file.read": { mutating: false },
  "sandbox.file.write": { mutating: true },
  "sandbox.exec": { mutating: true },
  "sandbox.exec.cancel": { mutating: true },
  "sandbox.sync": { mutating: true },
  "sandbox.reset": { mutating: true },
  "changes.submit": { mutating: true },
  "changes.diff": { mutating: false },

  "memory.list": { mutating: false },
  "memory.get": { mutating: false },
  "memory.history": { mutating: false },
  "memory.put": { mutating: true },
  "memory.delete": { mutating: true },

  "decisions.list": { mutating: false },
  "decisions.get": { mutating: false },
  "decisions.propose": { mutating: true },
  "decisions.add_position": { mutating: true },
  "decisions.decide": { mutating: true },
  "decisions.withdraw": { mutating: true },
  "decisions.veto": { mutating: true },

  "tools.list": { mutating: false },
  "tools.invoke": { mutating: true },

  "a2a.remotes.add": { mutating: true },
  "a2a.remotes.refresh": { mutating: true },
  "a2a.remotes.list": { mutating: false },

  "integrations.connect": { mutating: true },
  "integrations.disconnect": { mutating: true },
  "integrations.verify": { mutating: true },
  "integrations.list": { mutating: false },

  "git.import": { mutating: true },
  "git.pull_upstream": { mutating: true },
  "checkpoints.create": { mutating: true },
  "checkpoints.list": { mutating: false },
  "checkpoints.export": { mutating: true },
  "workspace.snapshot.create": { mutating: true },
  "workspace.snapshot.list": { mutating: false },
  "workspace.snapshot.get": { mutating: false },
  "workspace.snapshot.delete": { mutating: true },
  "room.branch": { mutating: true },
  "room.branches.list": { mutating: false },
  "room.branches.merge": { mutating: true },
} as const satisfies Record<string, { mutating: boolean }>;

export type MethodName = keyof typeof METHODS;

export const METHOD_NAMES = Object.keys(METHODS) as MethodName[];

/** `resource.action`: two or more lowercase snake_case segments separated by dots. */
export const METHOD_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function isMethodName(method: string): method is MethodName {
  return Object.hasOwn(METHODS, method);
}

/**
 * Whether `method` mutates state and so requires an idempotency key. False for a method
 * that isn't in the catalog: the dispatcher answers those with `NOT_FOUND`.
 */
export function isMutatingMethod(method: string): boolean {
  return isMethodName(method) && METHODS[method].mutating;
}

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * The command envelope (ARCHITECTURE §16.2). Unknown fields are rejected. `method` only has
 * to look like `resource.action`: whether it exists is the dispatcher's call (`NOT_FOUND`,
 * T117). `idempotency_key` is required when the method is mutating (§16.2), optional (but
 * still validated) otherwise, and not required for a method nobody has registered.
 */
export const commandEnvelopeSchema = z
  .object({
    id: z.custom<Id<"cmd">>((v) => isId(v, "cmd"), "expected a cmd_ ID"),
    method: z.string().regex(METHOD_PATTERN, "expected resource.action"),
    params: z.record(z.string(), z.unknown()),
    idempotency_key: z.string().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((envelope, ctx) => {
    if (envelope.idempotency_key === undefined && isMutatingMethod(envelope.method)) {
      ctx.addIssue({
        code: "custom",
        path: ["idempotency_key"],
        message: `idempotency_key is required for mutating method ${envelope.method}`,
      });
    }
  });

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
