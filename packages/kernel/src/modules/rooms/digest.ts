import { listEvents } from "@crossover/ledger";
import type { RoomEvent } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import { redactEventFor } from "./redact.js";

/** Most events one digest reads; past that it says so and where to continue. */
export const MAX_DIGEST_EVENTS = 5000;
const PAGE = 500;

export const roomDigestParams = z.strictObject({
  /** Summarize events after this sequence (the last one you have). Default: from the start. */
  since: z.number().int().min(0).default(0),
});

export interface DigestTask {
  task_id: string;
  /** The title, if the task was created inside this range. */
  title: string | null;
  event_count: number;
  /** The task events in the range, in order. */
  events: { sequence: number; type: string }[];
}

export interface Digest {
  since: number;
  /** The last sequence read: pass it as `since` next time. */
  up_to: number;
  event_count: number;
  /** One digest read its maximum: there may be more past `up_to`. */
  truncated: boolean;
  /** Events per type, keys sorted. */
  counts: Record<string, number>;
  /** Tasks that had events in the range, in order of their first event. */
  tasks: DigestTask[];
  /** Decision events in the range, in order. */
  decisions: { sequence: number; type: string; decision_id: string | null; title: string | null }[];
  /** Memory keys written or removed in the range, sorted. */
  memory_keys: string[];
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const obj = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/**
 * Summarize `events` (already in sequence order and already filtered to what the reader may
 * see) into a digest (§17.3). A pure function of its input: the same events give the same
 * object, with every collection in a fixed order, so the JSON is byte-identical.
 */
export function buildDigest(
  since: number,
  events: readonly RoomEvent[],
  truncated: boolean,
): Digest {
  const counts = new Map<string, number>();
  const tasks = new Map<string, DigestTask>();
  const decisions: Digest["decisions"] = [];
  const memory = new Set<string>();

  for (const e of events) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    const payload = obj(e.payload);
    if (e.type.startsWith("task.")) {
      const created = e.type === "task.created" ? obj(payload.task) : {};
      const id = str(payload.task_id) ?? str(created.id);
      if (id !== null) {
        const entry = tasks.get(id) ?? { task_id: id, title: null, event_count: 0, events: [] };
        if (e.type === "task.created") entry.title = str(created.title);
        entry.event_count += 1;
        entry.events.push({ sequence: e.sequence, type: e.type });
        tasks.set(id, entry);
      }
    } else if (e.type.startsWith("decision.")) {
      const decision = obj(payload.decision);
      decisions.push({
        sequence: e.sequence,
        type: e.type,
        decision_id: str(payload.decision_id) ?? str(decision.id),
        title: str(payload.title) ?? str(decision.title),
      });
    } else if (e.type.startsWith("memory.")) {
      const key = str(payload.key) ?? str(obj(payload.entry).key);
      if (key !== null) memory.add(key);
    }
  }

  const last = events[events.length - 1];
  return {
    since,
    up_to: last ? last.sequence : since,
    event_count: events.length,
    truncated,
    counts: Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    tasks: [...tasks.values()],
    decisions,
    memory_keys: [...memory].sort(),
  };
}

/**
 * Register `room.digest { since }` (T410, §17.3): a compact, deterministic summary of what
 * happened since a sequence, from the ledger alone (no model): events per type, task changes,
 * decisions and memory keys. It is read through {@link redactEventFor} like every other read,
 * so a reader never learns from a digest what the event stream would hide from them. One call
 * reads at most {@link MAX_DIGEST_EVENTS} events; `truncated` says there is more and `up_to`
 * is where to continue. (Workspace, conflict and health sections arrive with M5/M6.)
 */
export function registerRoomDigestCommand(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "room.digest",
    action: "room.read",
    mutating: false,
    view: "participant",
    params: roomDigestParams,
    execute: async (ctx, p) => {
      const { rows } = await ctx.client.query<{ role: string; authority: string }>(
        "SELECT role, authority FROM participants WHERE id = $1 AND room_id = $2",
        [ctx.principal.participant_id, ctx.room_id],
      );
      const viewer = {
        participant_id: ctx.principal.participant_id,
        role: rows[0]?.role ?? ctx.principal.role,
        authority: rows[0]?.authority ?? ctx.principal.authority,
      };
      const events: RoomEvent[] = [];
      let after = p.since;
      let truncated = false;
      for (;;) {
        const page = await listEvents(ctx.client, ctx.room_id, { after, limit: PAGE });
        for (const e of page) events.push(redactEventFor(viewer, e));
        const last = page[page.length - 1];
        if (!last || page.length < PAGE) break;
        after = last.sequence;
        if (events.length >= MAX_DIGEST_EVENTS) {
          truncated = true;
          break;
        }
      }
      return { response: buildDigest(p.since, events, truncated) };
    },
  });
}
