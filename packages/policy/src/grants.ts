import type { Pool, PoolClient } from "@crossover/db";

export interface LiveGrant {
  id: string;
  capability: string;
  requires_approval: boolean;
  expires_at: Date | null;
}

export interface LiveGrants {
  /** Capabilities added beyond the role bundle. */
  grants: LiveGrant[];
  /** Capabilities removed from the role bundle. */
  denies: LiveGrant[];
}

/**
 * A participant's grants and denies that count right now: not ended, not expired (T210).
 * Read on every authorization, so a revoke applies to the very next command.
 */
export async function loadLiveGrants(
  db: Pool | PoolClient,
  roomId: string,
  participantId: string,
): Promise<LiveGrants> {
  const { rows } = await db.query<LiveGrant & { effect: "GRANT" | "DENY" }>(
    `SELECT id, effect, capability, requires_approval, expires_at
     FROM capability_grants
     WHERE room_id = $1 AND participant_id = $2 AND ended_at IS NULL
       AND (expires_at IS NULL OR expires_at > clock_timestamp())
     ORDER BY created_at, id`,
    [roomId, participantId],
  );
  const live: LiveGrants = { grants: [], denies: [] };
  for (const { effect, ...row } of rows) (effect === "GRANT" ? live.grants : live.denies).push(row);
  return live;
}
