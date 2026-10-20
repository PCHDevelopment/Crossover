import type { PoolClient } from "@crossover/db";
import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher, EmittedEvent, RoomlessContext, UserPrincipal } from "../../dispatcher.js";
import { registerRoomEgressAllowlistCommand } from "./egress.js";
import { registerRoomStateCommand, type StateSectionRegistry } from "./state.js";

/** Slugs are lowercase letters, digits and hyphens, 3–48 characters. */
export const SLUG_PATTERN = /^[a-z0-9-]{3,48}$/;

export const roomCreateParams = z.object({
  slug: z.string().regex(SLUG_PATTERN, "3–48 characters of a-z, 0-9 and -"),
  name: z.string().min(1).max(200),
  objective: z.string().min(1).max(5_000),
  settings: z.record(z.string(), z.unknown()).default({}),
});

export type RoomCreateParams = z.infer<typeof roomCreateParams>;

export interface RoomCreateResponse {
  room: {
    id: string;
    slug: string;
    name: string;
    objective: string;
    status: "ACTIVE";
    owner_id: string;
    lead_participant_id: string;
    settings: Record<string, unknown>;
  };
  participant: {
    id: string;
    room_id: string;
    kind: "HUMAN";
    display_name: string;
    authority: "OWNER";
    role: "LEAD";
    status: "ACTIVE";
    user_id: string;
  };
}

export interface RoomCommandDeps {
  /**
   * Called inside the room-creating transaction, after the room and its owner exist, to set
   * up whatever else a new room needs (the workspace repository and revision 0, T512's
   * `provisionWorkspace`). Injected because the workspace package depends on the kernel, so
   * the kernel can't import it. If it throws, the room isn't created.
   */
  provision?: (ctx: { client: PoolClient; room_id: string }) => Promise<void>;
  /** The sections of `room.get_state`; defaults to `room` and `participants`. */
  stateSections?: StateSectionRegistry;
}

/** Register the room commands (`room.create`, `room.get_state`) on a dispatcher. */
export function registerRoomCommands(dispatcher: Dispatcher, deps: RoomCommandDeps = {}): void {
  registerRoomStateCommand(dispatcher, deps.stateSections);
  registerRoomEgressAllowlistCommand(dispatcher);
  dispatcher.registerRoomlessCommand({
    method: "room.create",
    params: roomCreateParams,
    execute: (ctx, params) => createRoom(ctx, params, deps),
  });
}

/**
 * Create a room and its creator as `HUMAN` + `OWNER` + `LEAD` (the owner leads until a lead
 * is appointed). Emits `room.created` then `participant.joined`, which land at sequences 1
 * and 2 of the new room's ledger.
 */
async function createRoom(
  ctx: RoomlessContext,
  params: RoomCreateParams,
  deps: RoomCommandDeps,
): Promise<{
  response: RoomCreateResponse;
  events: EmittedEvent[];
}> {
  const { room_id, client, user } = ctx;
  const room = { id: room_id, ...params };
  const { participant_id: participantId } = await insertRoomWithOwner(client, room, user);

  await deps.provision?.({ client, room_id });

  return {
    response: {
      room: {
        id: room_id,
        slug: params.slug,
        name: params.name,
        objective: params.objective,
        status: "ACTIVE",
        owner_id: participantId,
        lead_participant_id: participantId,
        settings: params.settings,
      },
      participant: {
        id: participantId,
        room_id,
        kind: "HUMAN",
        display_name: user.display_name,
        authority: "OWNER",
        role: "LEAD",
        status: "ACTIVE",
        user_id: user.user_id,
      },
    },
    events: roomCreatedEvents(room, {
      participant_id: participantId,
      display_name: user.display_name,
    }),
  };
}

/** Insert a new room and its human owner in the caller's transaction. */
export async function insertRoomWithOwner(
  client: PoolClient,
  room: RoomCreateParams & { id: string },
  user: UserPrincipal,
): Promise<{ participant_id: string }> {
  const participantId = newId("part");
  try {
    await client.query(
      `INSERT INTO rooms (id, slug, name, objective, status, owner_id, lead_participant_id, settings)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5, $6::jsonb)`,
      [room.id, room.slug, room.name, room.objective, participantId, JSON.stringify(room.settings)],
    );
  } catch (err) {
    if (isUniqueViolation(err, "rooms_slug_key")) {
      throw new CrossoverError("VALIDATION", `Slug "${room.slug}" is already taken`, {
        details: { slug: room.slug, reason: "slug_taken" },
        cause: err,
      });
    }
    throw err;
  }

  await client.query(
    `INSERT INTO participants
       (id, room_id, kind, display_name, authority, role, status, user_id, joined_at)
     VALUES ($1, $2, 'HUMAN', $3, 'OWNER', 'LEAD', 'ACTIVE', $4, clock_timestamp())`,
    [participantId, room.id, user.display_name, user.user_id],
  );
  return { participant_id: participantId };
}

/** Build the first two ledger events for a newly created room. */
export function roomCreatedEvents(
  room: RoomCreateParams & { id: string },
  owner: { participant_id: string; display_name: string },
): EmittedEvent[] {
  return [
    {
      type: "room.created",
      actor_id: owner.participant_id,
      payload: {
        slug: room.slug,
        name: room.name,
        objective: room.objective,
        owner_id: owner.participant_id,
      },
    },
    {
      type: "participant.joined",
      actor_id: owner.participant_id,
      payload: {
        participant_id: owner.participant_id,
        kind: "HUMAN",
        authority: "OWNER",
        role: "LEAD",
        display_name: owner.display_name,
      },
    },
  ];
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === "23505" && e.constraint === constraint;
}
