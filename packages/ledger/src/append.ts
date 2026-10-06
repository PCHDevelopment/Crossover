import type { PoolClient } from "@crossover/db";
import {
  canonicalJson,
  CrossoverError,
  eventTypeSchema,
  roomEventSchema,
  sha256Hex,
  type EventType,
  type RoomEvent,
} from "@crossover/protocol";
import { z } from "zod";

/** An event to append; the ledger assigns `sequence`, `timestamp` and `payload_hash`. */
export interface NewEvent {
  actor_id: string;
  type: EventType;
  payload?: Record<string, unknown>;
  /** The command that caused this event (§19.1). */
  causation_id?: string | null;
  schema_version?: number;
}

const newEventSchema = z.object({
  actor_id: z.string().min(1),
  type: eventTypeSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  causation_id: z.string().min(1).nullable().default(null),
  schema_version: z.number().int().min(1).default(1),
});

interface EventRow {
  sequence: string; // bigint comes back from pg as a string
  room_id: string;
  actor_id: string;
  type: string;
  schema_version: number;
  timestamp: Date;
  causation_id: string | null;
  payload: Record<string, unknown>;
  payload_hash: string;
  redacted: boolean;
}

/**
 * Append events to a room's ledger (§19.2). Must run inside the caller's transaction:
 * it locks the room row (`FOR UPDATE`), assigns sequences `last_sequence + 1 … + n`,
 * inserts the events, and advances `last_sequence`. Because the lock is held until the
 * caller commits, concurrent appenders to one room are serialized and sequences are
 * gap-free; a rollback undoes the events and the counter together. Appends to different
 * rooms don't contend.
 *
 * Fencing (§4.2): `fencingToken` is the token from the caller's {@link acquireLease}. In
 * the same transaction, after locking the room, the room's lease row is read `FOR SHARE`
 * and the write is rejected with `STALE_FENCE` (nothing written) unless that lease is
 * unexpired and holds exactly this token. The share lock stays until the caller commits, so
 * a takeover can't commit between the check and this write: it waits for us, and any later
 * write with the old token is rejected. A zombie owner therefore can't corrupt the ledger.
 *
 * `payload_hash` is `sha256:` + hex SHA-256 of the canonical JSON of the payload.
 * Returns the stored events, validated against `roomEventSchema`.
 */
export async function appendEvents(
  client: PoolClient,
  roomId: string,
  events: readonly NewEvent[],
  fencingToken: number,
): Promise<RoomEvent[]> {
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new CrossoverError("VALIDATION", "fencingToken must be a positive integer", {
      details: { fencingToken },
    });
  }
  const parsed = events.map((event, i) => {
    const result = newEventSchema.safeParse(event);
    if (!result.success) {
      throw new CrossoverError("VALIDATION", `Invalid event at index ${i}`, {
        details: { index: i, issues: result.error.issues },
      });
    }
    return result.data;
  });
  if (parsed.length === 0) return [];

  // Hash before taking the lock so a bad payload (e.g. undefined) fails without locking.
  const hashes = parsed.map((e) => `sha256:${sha256Hex(canonicalJson(e.payload))}`);

  const room = await client.query<{ last_sequence: string }>(
    "SELECT last_sequence FROM rooms WHERE id = $1 FOR UPDATE",
    [roomId],
  );
  const current = room.rows[0];
  if (!current) {
    throw new CrossoverError("NOT_FOUND", `Room ${roomId} not found`, {
      details: { room_id: roomId },
    });
  }

  const lease = await client.query<{ fencing_token: string; live: boolean }>(
    `SELECT fencing_token, expires_at > clock_timestamp() AS live
       FROM room_leases WHERE room_id = $1 FOR SHARE`,
    [roomId],
  );
  const held = lease.rows[0];
  if (!held || !held.live || Number(held.fencing_token) !== fencingToken) {
    throw new CrossoverError("STALE_FENCE", `Stale fencing token for room ${roomId}`, {
      details: {
        room_id: roomId,
        fencing_token: fencingToken,
        current_token: held ? Number(held.fencing_token) : null,
        lease_live: held?.live ?? false,
      },
    });
  }

  const first = BigInt(current.last_sequence) + 1n;

  const stored: RoomEvent[] = [];
  for (const [i, event] of parsed.entries()) {
    const { rows } = await client.query<EventRow>(
      `INSERT INTO events
         (room_id, sequence, actor_id, type, schema_version, timestamp, causation_id, payload, payload_hash)
       VALUES ($1, $2, $3, $4, $5, clock_timestamp(), $6, $7::jsonb, $8)
       RETURNING *`,
      [
        roomId,
        (first + BigInt(i)).toString(),
        event.actor_id,
        event.type,
        event.schema_version,
        event.causation_id,
        canonicalJson(event.payload),
        hashes[i],
      ],
    );
    stored.push(toRoomEvent(rows[0]!));
  }

  await client.query("UPDATE rooms SET last_sequence = $2 WHERE id = $1", [
    roomId,
    (first + BigInt(parsed.length) - 1n).toString(),
  ]);
  return stored;
}

/** Convert a database row to the wire shape (§19.1). */
export function toRoomEvent(row: EventRow): RoomEvent {
  return roomEventSchema.parse({
    ...row,
    sequence: Number(row.sequence),
    timestamp: row.timestamp.toISOString(),
  });
}
