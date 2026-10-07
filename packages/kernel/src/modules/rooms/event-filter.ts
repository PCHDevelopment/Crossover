import type { Pool } from "@crossover/db";
import type { RoomEvent } from "@crossover/protocol";
import { z } from "zod";
import type { Principal } from "../../principal.js";

/** How much of the room's stream a subscriber wants (§17.1). */
export const PROFILES = ["relevant", "all", "custom"] as const;
export type Profile = (typeof PROFILES)[number];

const typePattern = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z_*]+(\.[a-z_*]+)*$/, "an event type, or a pattern with * (e.g. task.*)");

export const filterParams = {
  /** Default: `relevant` for an agent, `all` for a human. */
  profile: z.enum(PROFILES).optional(),
  /** `custom`: event types to deliver, `*` matches within a name (`task.*`, `workspace.conflict.*`). */
  types: z.array(typePattern).min(1).max(50).optional(),
  /** `custom`: narrow by who the event is about. */
  scopes: z
    .strictObject({
      /** `mine`: task events only for tasks I own (or that name me). `all`: every task event. */
      tasks: z.enum(["mine", "all"]).optional(),
      /** Also deliver messages that mention me, whatever `types` says. */
      mentions: z.boolean().optional(),
    })
    .optional(),
};

export interface SubscriptionFilter {
  profile: Profile;
  types?: string[];
  scopes?: { tasks?: "mine" | "all"; mentions?: boolean };
}

/** The profile a subscriber gets by default. */
export const defaultProfile = (kind: "HUMAN" | "AGENT"): Profile =>
  kind === "AGENT" ? "relevant" : "all";

/** Check a requested filter and fill in the default profile. */
export function resolveFilter(
  kind: "HUMAN" | "AGENT",
  requested: {
    profile?: Profile | undefined;
    types?: string[] | undefined;
    scopes?: { tasks?: "mine" | "all" | undefined; mentions?: boolean | undefined } | undefined;
  },
): SubscriptionFilter {
  const profile =
    requested.profile ?? (requested.types || requested.scopes ? "custom" : defaultProfile(kind));
  if (profile !== "custom" && (requested.types || requested.scopes)) {
    throw new Error("types and scopes belong to the custom profile");
  }
  return {
    profile,
    ...(requested.types ? { types: [...new Set(requested.types)] } : {}),
    ...(requested.scopes
      ? {
          scopes: {
            ...(requested.scopes.tasks ? { tasks: requested.scopes.tasks } : {}),
            ...(requested.scopes.mentions !== undefined
              ? { mentions: requested.scopes.mentions }
              : {}),
          },
        }
      : {}),
  };
}

/** `task.*` matches `task.created` (the star stays inside one dotted name). */
export function typeMatches(pattern: string, type: string): boolean {
  if (!pattern.includes("*")) return pattern === type;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[a-z_]*");
  return new RegExp(`^${source}$`).test(type);
}

/** Payload keys that name the participant an event is about. */
const ABOUT_KEYS = [
  "participant_id",
  "owner_id",
  "assignee_id",
  "previous_owner_id",
  "requester_id",
  "reviewer_id",
  "target_id",
  "submitter_id",
  "resolver_id",
  "to",
];

const names = (payload: Record<string, unknown>, me: string): boolean => {
  for (const key of ABOUT_KEYS) if (payload[key] === me) return true;
  const nested = (payload["task"] ?? payload["decision"] ?? payload["position"]) as
    Record<string, unknown> | undefined;
  if (nested && typeof nested === "object") {
    for (const key of ABOUT_KEYS) if (nested[key] === me) return true;
  }
  return false;
};

const mentions = (payload: Record<string, unknown>, me: string): boolean => {
  const message = payload["message"] as { mentions?: unknown } | undefined;
  return Array.isArray(message?.mentions) && message.mentions.includes(me);
};

/**
 * Whether an event is about this participant (§17.1 `relevant`): its task changed or was
 * assigned, a mention, a conflict on its ChangeSet, its sandbox, a lead's decision, a change of
 * lead, a room status change, an approval, a budget or capability change that concerns it, and
 * health turning RED on a range that includes its ChangeSets.
 */
async function isRelevant(db: Pool, principal: Principal, event: RoomEvent): Promise<boolean> {
  const me = principal.participant_id;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const type = event.type;
  if (/^room\./.test(type) || /^lead\./.test(type)) return true;
  if (/^decision\.(decided|vetoed|superseded)$/.test(type)) return true;
  if (type === "message.sent" || type === "message.edited") return mentions(p, me);
  if (type === "capability.denied") return event.actor_id === me;
  if (type === "workspace.health") {
    if (p["status"] !== "RED") return false;
    const { rowCount } = await db.query(
      `SELECT 1 FROM inbox_items WHERE room_id = $1 AND participant_id = $2
         AND kind = 'HEALTH_RED' AND ref ->> 'id' = $3`,
      [event.room_id, me, String(p["log_ref"] ?? "")],
    );
    return (rowCount ?? 0) > 0;
  }
  if (/^task\./.test(type)) {
    if (names(p, me)) return true;
    const id = typeof p["task_id"] === "string" ? p["task_id"] : undefined;
    if (!id) return false;
    const { rowCount } = await db.query(
      "SELECT 1 FROM tasks WHERE id = $1 AND room_id = $2 AND owner_id = $3",
      [id, event.room_id, me],
    );
    return (rowCount ?? 0) > 0;
  }
  if (/^workspace\.(changeset|conflict)\./.test(type)) {
    if (names(p, me)) return true;
    const id = typeof p["changeset_id"] === "string" ? p["changeset_id"] : undefined;
    if (id) {
      const { rowCount } = await db.query(
        "SELECT 1 FROM changesets WHERE id = $1 AND room_id = $2 AND actor_id = $3",
        [id, event.room_id, me],
      );
      if ((rowCount ?? 0) > 0) return true;
    }
    // An escalated conflict is the lead's to resolve.
    return type === "workspace.conflict.escalated" && principal.role === "LEAD";
  }
  // Participants, approvals, budgets, sandboxes, checkpoints, …: when they name this participant.
  return names(p, me);
}

/**
 * The test a connection applies to each event of the stream (T704). It answers in order and never
 * throws: if the database can't be asked, the event is delivered (a filter may drop noise, never
 * information). The viewer's redaction still applies to whatever passes.
 */
export function createEventMatcher(
  db: Pool,
  principal: Principal,
  filter: SubscriptionFilter,
): (event: RoomEvent) => Promise<boolean> {
  if (filter.profile === "all") return async () => true;
  return async (event) => {
    try {
      if (filter.profile === "relevant") return await isRelevant(db, principal, event);
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const me = principal.participant_id;
      if (filter.scopes?.mentions && event.type === "message.sent" && mentions(p, me)) return true;
      const typeOk =
        filter.types === undefined || filter.types.some((t) => typeMatches(t, event.type));
      if (!typeOk) return false;
      if (filter.scopes?.tasks === "mine" && /^task\./.test(event.type)) {
        return await isRelevant(db, principal, event);
      }
      return true;
    } catch {
      return true;
    }
  };
}
