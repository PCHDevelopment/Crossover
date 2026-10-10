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

/**
 * Glob over one dotted-name segment (`*` matches any run of characters within it), without a
 * regex: the two-pointer walk never backtracks over more than the last star, so its cost is
 * bounded by the pattern times the name (quadratic at worst, never exponential).
 */
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** `task.*` matches `task.created` (the star stays inside one dotted name). */
export function typeMatches(pattern: string, type: string): boolean {
  const want = pattern.split(".");
  const have = type.split(".");
  return want.length === have.length && want.every((w, i) => segmentMatches(w, have[i]!));
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
  "author_id",
  "escalated_to",
];

/** Payload keys that list participants an event is about. */
const ABOUT_LISTS = ["suspect_ids"];

const names = (payload: Record<string, unknown>, me: string): boolean => {
  for (const key of ABOUT_KEYS) if (payload[key] === me) return true;
  for (const key of ABOUT_LISTS) {
    const list = payload[key];
    if (Array.isArray(list) && list.includes(me)) return true;
  }
  const nested = (payload["task"] ?? payload["decision"] ?? payload["position"]) as
    Record<string, unknown> | undefined;
  if (nested && typeof nested === "object") {
    for (const key of ABOUT_KEYS) if (nested[key] === me) return true;
  }
  return false;
};

/** The mentions an event carries, or `undefined` when it carries none of the field (written before it existed). */
const mentionsOf = (payload: Record<string, unknown>): unknown[] | undefined => {
  const direct = payload["mentions"]; // message.edited
  if (Array.isArray(direct)) return direct;
  const message = payload["message"] as { mentions?: unknown } | undefined; // message.sent
  return Array.isArray(message?.mentions) ? message.mentions : undefined;
};
const mentions = (payload: Record<string, unknown>, me: string): boolean =>
  mentionsOf(payload)?.includes(me) ?? false;

/**
 * Whether an event is about this participant (§17.1 `relevant`): its task changed or was
 * assigned or sent to it for review (and a new task nobody owns yet), a mention, a conflict or
 * ChangeSet event on its own ChangeSets, its sandbox, a lead's decision, a change of lead, a room
 * status change, an approval, a budget or capability change that concerns it, and health turning
 * RED where it is a suspect. **Decided from the event alone**: what an event is about travels in
 * its payload as of that moment, so a replay from `after` and the live stream agree, and nothing
 * here asks the database.
 *
 * **Fail open.** An event written before its type carried the field this needs (`owner_id` on
 * task events, `author_id` on ChangeSets, `submitter_id` on resolved conflicts, `suspect_ids` on
 * health, `mentions` on edits) is
 * delivered: a filter is a convenience, not a security boundary, and an agent resuming across an
 * upgrade must not lose what happened meanwhile. Redaction for the viewer still applies.
 */
function isRelevant(principal: Principal, event: RoomEvent): boolean {
  const me = principal.participant_id;
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const type = event.type;
  const lacks = (key: string) => !(key in p);
  if (/^room\./.test(type) || /^lead\./.test(type)) return true;
  if (/^decision\.(decided|vetoed|superseded)$/.test(type)) return true;
  if (type === "message.sent") return mentions(p, me);
  if (type === "message.edited") return mentionsOf(p) === undefined || mentions(p, me);
  if (type === "capability.denied") return event.actor_id === me;
  if (type === "workspace.health") {
    if (p["status"] !== "RED") return false;
    return lacks("suspect_ids") || names(p, me);
  }
  if (type === "task.created") {
    // Unowned tasks are for whoever claims from the open pool.
    const task = p["task"] as { owner_id?: unknown } | undefined;
    return names(p, me) || task?.owner_id === null || task?.owner_id === undefined;
  }
  if (/^task\./.test(type)) return lacks("owner_id") || names(p, me);
  if (type === "workspace.changeset.applied") return lacks("author_id") || names(p, me);
  if (type === "workspace.conflict.resolved") return lacks("submitter_id") || names(p, me);
  if (/^workspace\.(changeset|conflict)\./.test(type)) return names(p, me);
  // Participants, approvals, budgets, sandboxes, checkpoints, …: when they name this participant.
  return names(p, me);
}

/**
 * The test a connection applies to each event of the stream (T704). Pure and synchronous: it
 * reads the event and nothing else, so it cannot reorder the stream or disagree between a replay
 * and the live feed. The viewer's redaction still applies to whatever passes.
 */
export function createEventMatcher(
  principal: Principal,
  filter: SubscriptionFilter,
): (event: RoomEvent) => boolean {
  if (filter.profile === "all") return () => true;
  if (filter.profile === "relevant") return (event) => isRelevant(principal, event);
  const me = principal.participant_id;
  const types = filter.types?.map((t) => t.split("."));
  const typeOk = (type: string): boolean => {
    if (!types) return true;
    const have = type.split(".");
    return types.some(
      (want) => want.length === have.length && want.every((w, i) => segmentMatches(w, have[i]!)),
    );
  };
  return (event) => {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    if (
      filter.scopes?.mentions &&
      (event.type === "message.sent" || event.type === "message.edited") &&
      mentions(p, me)
    ) {
      return true;
    }
    if (!typeOk(event.type)) return false;
    if (filter.scopes?.tasks === "mine" && /^task\./.test(event.type)) return names(p, me);
    return true;
  };
}
