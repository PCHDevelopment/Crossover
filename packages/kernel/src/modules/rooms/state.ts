import type { PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";

export type StateView = "summary" | "full";

export interface StateSectionContext {
  /** In the read snapshot: every section sees the same data as `last_sequence`. */
  client: PoolClient;
  room_id: string;
  view: StateView;
  principal: Principal;
}

export interface StateSection {
  /** The key under `sections` in the response. */
  name: string;
  /** Views the section appears in; defaults to both. */
  views?: readonly StateView[];
  load(ctx: StateSectionContext): Promise<unknown>;
}

/**
 * The named sections of `room.get_state`. Later milestones (tasks, messages, memory, …) add
 * theirs with {@link register} instead of editing this module.
 */
export class StateSectionRegistry {
  private readonly sections = new Map<string, StateSection>();

  register(section: StateSection): void {
    if (this.sections.has(section.name)) {
      throw new Error(`State section "${section.name}" is already registered`);
    }
    this.sections.set(section.name, section);
  }

  forView(view: StateView): StateSection[] {
    return [...this.sections.values()].filter((s) =>
      (s.views ?? ["summary", "full"]).includes(view),
    );
  }
}

export const roomStateParams = z.object({
  view: z.enum(["summary", "full"]).default("summary"),
  /**
   * The room the caller believes it is asking about. If it isn't the principal's room the
   * answer is `NOT_FOUND`, never `FORBIDDEN`, so room ids can't be probed.
   */
  room_id: z.string().min(1).optional(),
});

export interface RoomState {
  view: StateView;
  /** The room's ledger position the sections were read at. */
  last_sequence: number;
  sections: Record<string, unknown>;
}

/** The built-in sections: `room` and `participants`. */
export function defaultStateSections(): StateSectionRegistry {
  const registry = new StateSectionRegistry();

  registry.register({
    name: "room",
    async load({ client, room_id }) {
      const { rows } = await client.query(
        `SELECT id, slug, name, objective, status, owner_id, lead_participant_id,
                settings, created_at, archived_at
           FROM rooms WHERE id = $1`,
        [room_id],
      );
      return rows[0] ?? null;
    },
  });

  registry.register({
    name: "participants",
    async load({ client, room_id, view }) {
      // Never user_id (the platform account). A summary leaves out budgets and the agent
      // manifest and hides removed participants. The full view has them, except the manifest
      // omits wake_webhook_url (an agent's private endpoint, §17.4).
      const full = view === "full";
      const { rows } = await client.query(
        `SELECT id, kind, display_name, authority, role, status, joined_at, last_seen_at
                ${full ? ", budgets, CASE WHEN kind = 'AGENT' THEN agent_manifest - 'wake_webhook_url' END AS agent_manifest" : ""}
           FROM participants
          WHERE room_id = $1 ${full ? "" : "AND status <> 'REMOVED'"}
          ORDER BY joined_at NULLS LAST, id`,
        [room_id],
      );
      return rows;
    },
  });

  return registry;
}

/** Run `fn` against one consistent snapshot of the database (read-only, repeatable read). */
async function inSnapshot<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    return await fn();
  } finally {
    await client.query("ROLLBACK"); // nothing was written; this just ends the snapshot
  }
}

/** Register `room.get_state` (T203). */
export function registerRoomStateCommand(
  dispatcher: Dispatcher,
  sections: StateSectionRegistry = defaultStateSections(),
): void {
  dispatcher.registerCommand({
    method: "room.get_state",
    action: "room.read",
    mutating: false,
    params: roomStateParams,
    execute: async (ctx, params) => {
      if (params.room_id !== undefined && params.room_id !== ctx.room_id) {
        throw notFound(params.room_id);
      }
      const state = await inSnapshot(ctx.client, async () => {
        const { rows } = await ctx.client.query<{ last_sequence: string }>(
          "SELECT last_sequence FROM rooms WHERE id = $1",
          [ctx.room_id],
        );
        const room = rows[0];
        if (!room) throw notFound(ctx.room_id);

        const loaded: Record<string, unknown> = {};
        for (const section of sections.forView(params.view)) {
          loaded[section.name] = await section.load({
            client: ctx.client,
            room_id: ctx.room_id,
            view: params.view,
            principal: ctx.principal,
          });
        }
        const result: RoomState = {
          view: params.view,
          last_sequence: Number(room.last_sequence),
          sections: loaded,
        };
        return result;
      });
      // Timestamps become ISO strings: the response is plain JSON data.
      return { response: JSON.parse(JSON.stringify(state)) as RoomState };
    },
  });
}

function notFound(roomId: string): CrossoverError {
  return new CrossoverError("NOT_FOUND", "Room not found", { details: { room_id: roomId } });
}
