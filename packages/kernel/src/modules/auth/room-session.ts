import type { Pool, PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import type { UserPrincipal } from "../../dispatcher.js";
import { issueTokens, type TokenPair } from "./tokens.js";

export interface RoomSession {
  participant_id: string;
  room_id: string;
  role: string;
  authority: string;
  display_name: string;
  tokens: TokenPair;
}

/**
 * Exchange a platform user for room tokens (T217, §15.3: room access comes from membership).
 * The user must be an `ACTIVE` or `PAUSED` HUMAN participant of the room through
 * `participants.user_id`; each call starts a fresh token family. A paused member gets tokens
 * (pausing doesn't revoke them; their commands answer `PARTICIPANT_PAUSED`).
 *
 * - No participant for this user, or no such room: `NOT_FOUND`, the same for both, so the
 *   answer doesn't reveal which rooms exist.
 * - A removed or merely invited member knows the room exists: `FORBIDDEN`.
 */
export async function exchangeRoomSession(
  db: Pool | PoolClient,
  user: UserPrincipal,
  roomId: string,
): Promise<RoomSession> {
  const { rows } = await db.query<{
    id: string;
    role: string;
    authority: string;
    display_name: string;
    status: string;
  }>(
    `SELECT id, role, authority, display_name, status
     FROM participants
     WHERE room_id = $1 AND user_id = $2 AND kind = 'HUMAN'
     ORDER BY joined_at NULLS LAST, id`,
    [roomId, user.user_id],
  );
  if (rows.length === 0) throw new CrossoverError("NOT_FOUND", "Room not found");
  const member = rows.find((r) => r.status === "ACTIVE" || r.status === "PAUSED");
  if (!member) {
    throw new CrossoverError("FORBIDDEN", "You are not an active member of this room", {
      details: { reason: `participant_${rows[0]!.status.toLowerCase()}` },
    });
  }
  const tokens = await issueTokens(db, member.id);
  return {
    participant_id: member.id,
    room_id: roomId,
    role: member.role,
    authority: member.authority,
    display_name: member.display_name,
    tokens,
  };
}
