import type { Pool, PoolClient } from "@crossover/db";
import { CrossoverError, EVENT_TYPES, type RoomEvent } from "@crossover/protocol";
import { toRoomEvent } from "./append.js";

export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

export interface ListEventsOptions {
  /** Return only events with `sequence > after`. Default 0 (from the start). */
  after?: number;
  /** Max events to return. Default 100, capped at 500. */
  limit?: number;
  /**
   * Filter by type: exact names (`task.created`) or `prefix.*` wildcards (`task.*`,
   * `workspace.conflict.*`). A wildcard matches types that start with `prefix.`.
   */
  types?: readonly string[];
}

/**
 * List a room's events in ascending sequence order, starting after `after`.
 * Clients use this to backfill gaps and resume (`room.events.list?after=`, §19.2).
 */
export async function listEvents(
  db: Pool | PoolClient,
  roomId: string,
  options: ListEventsOptions = {},
): Promise<RoomEvent[]> {
  const after = options.after ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) {
    throw validation("`after` must be a non-negative integer", { after });
  }
  const requested = options.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw validation("`limit` must be a positive integer", { limit: requested });
  }
  const limit = Math.min(requested, MAX_LIST_LIMIT);
  const types = options.types === undefined ? undefined : expandTypes(options.types);

  const params: unknown[] = [roomId, after, limit];
  let typeFilter = "";
  if (types) {
    params.push(types);
    typeFilter = "AND type = ANY($4::text[])";
  }
  const { rows } = await db.query(
    `SELECT * FROM events
      WHERE room_id = $1 AND sequence > $2 ${typeFilter}
      ORDER BY sequence ASC
      LIMIT $3`,
    params,
  );
  return rows.map(toRoomEvent);
}

/**
 * Expand exact names and `prefix.*` wildcards to concrete catalog types. Matching happens
 * here, not with SQL LIKE, so there is nothing to escape and `task.*` can't match `tasks_x`.
 */
function expandTypes(patterns: readonly string[]): string[] {
  if (patterns.length === 0) {
    throw validation("`types` must not be empty (omit it to match every type)", {});
  }
  const matched = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -1); // keeps the trailing "."
      const hits = EVENT_TYPES.filter((t) => t.startsWith(prefix));
      if (prefix.length < 2 || hits.length === 0) {
        throw validation(`Wildcard "${pattern}" matches no event type`, { pattern });
      }
      for (const t of hits) matched.add(t);
    } else if ((EVENT_TYPES as readonly string[]).includes(pattern)) {
      matched.add(pattern);
    } else {
      throw validation(`Unknown event type "${pattern}"`, { pattern });
    }
  }
  return [...matched];
}

function validation(message: string, details: Record<string, unknown>): CrossoverError {
  return new CrossoverError("VALIDATION", message, { details });
}
