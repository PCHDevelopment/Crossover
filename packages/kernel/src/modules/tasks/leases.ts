import type { Pool } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher } from "../../dispatcher.js";
import { loadActor } from "./create-update.js";
import { leaseSql, loadTask } from "./task.js";

/** Who is making these changes in the ledger when nobody is: the platform. */
export const SYSTEM_ACTOR = "system";

export const tasksHeartbeatParams = z.strictObject({ task_id: z.string().min(1).max(100) });

/**
 * Register `tasks.heartbeat { task_id }` (T311, §8.4): the task's owner says "still working",
 * which renews an agent's 15-minute claim lease. It changes nothing else, so it bumps no
 * version (a heartbeat must never make someone else's update conflict) and emits no event;
 * the catalog classes it as a read, so it also works while a room is frozen.
 * A human's claim has no lease, so for them it is a harmless no-op.
 */
export function registerTaskHeartbeat(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "tasks.heartbeat",
    // The catalog (§16.1) lists it as a read: no events, no version, no idempotency key. It
    // still writes the lease, in one atomic UPDATE, which is all a repeat needs.
    mutating: false,
    params: tasksHeartbeatParams,
    execute: async (ctx, p) => {
      const task = await loadTask(ctx.client, ctx.room_id, p.task_id);
      const actor = await loadActor(ctx);
      if (task.owner_id !== actor.id) {
        throw new CrossoverError("FORBIDDEN", "Only the task's owner can send a heartbeat", {
          details: { reason: "not_task_owner" },
        });
      }
      if (task.status !== "CLAIMED" && task.status !== "IN_PROGRESS" && task.status !== "BLOCKED") {
        throw new CrossoverError("VALIDATION", `A ${task.status} task has no claim to keep alive`, {
          details: { status: task.status },
        });
      }
      const { rows } = await ctx.client.query<{ lease_expires_at: Date | null }>(
        `UPDATE tasks t SET lease_expires_at = ${leaseSql("p.kind")}
         FROM participants p
         WHERE t.id = $1 AND t.room_id = $2 AND p.id = t.owner_id AND p.room_id = t.room_id
         RETURNING t.lease_expires_at`,
        [task.id, ctx.room_id],
      );
      const lease = rows[0]?.lease_expires_at ?? null;
      return {
        response: { task_id: task.id, lease_expires_at: lease ? lease.toISOString() : null },
      };
    },
  });
}

export interface SweepOptions {
  /** "Now" for the expiry test. Injectable so tests need no real waiting. Default: the current time. */
  now?: Date;
  /**
   * Is this agent connected (an open WebSocket, §17)? A lapsed lease only frees the task if
   * the agent is also gone. Default: nobody is, until presence exists, so an expired lease
   * alone releases the task.
   */
  isConnected?: (participantId: string) => boolean | Promise<boolean>;
  /** Rooms to sweep. Default: the rooms this node holds the lease for; a room's owner node sweeps it. */
  rooms?: readonly string[];
}

export interface SweptTask {
  room_id: string;
  task_id: string;
  previous_owner_id: string;
}

/**
 * Return agents' stale claims to `OPEN` (T311, §8.4): a task that is `CLAIMED`, `IN_PROGRESS`
 * or `BLOCKED`, owned by an **agent** whose lease has run out at `now` and who is not
 * connected, becomes `OPEN` with no owner, one version up, and a `task.lease_expired` event
 * per task. **Human claims never expire**, nor do tasks whose lease hasn't lapsed, tasks
 * waiting in `REVIEW` or finished tasks. Each room is swept on its own actor in its own
 * transaction, rechecking every condition under the row lock, so a heartbeat that lands first
 * wins. Only rooms this node owns are swept (`options.rooms` to choose), because only the
 * owner node may write to a room's ledger. (The lead's inbox notification arrives with T403.)
 */
export async function sweepExpiredLeases(
  dispatcher: Dispatcher,
  pool: Pool,
  options: SweepOptions = {},
): Promise<SweptTask[]> {
  const now = options.now ?? new Date();
  const isConnected = options.isConnected ?? (() => false);
  const rooms = options.rooms ?? dispatcher.leases.heldRooms();
  if (rooms.length === 0) return [];

  const { rows: candidates } = await pool.query<{ room_id: string; id: string; owner_id: string }>(
    `SELECT t.room_id, t.id, t.owner_id
     FROM tasks t JOIN participants p ON p.id = t.owner_id AND p.room_id = t.room_id
     WHERE t.status IN ('CLAIMED', 'IN_PROGRESS', 'BLOCKED')
       AND p.kind = 'AGENT' AND t.lease_expires_at IS NOT NULL AND t.lease_expires_at <= $1
       AND t.room_id = ANY($2::text[])
     ORDER BY t.room_id, t.id`,
    [now, rooms],
  );
  // Connected agents keep their tasks.
  const lapsed: typeof candidates = [];
  for (const c of candidates) if (!(await isConnected(c.owner_id))) lapsed.push(c);

  const byRoom = new Map<string, typeof lapsed>();
  for (const c of lapsed) byRoom.set(c.room_id, [...(byRoom.get(c.room_id) ?? []), c]);

  const swept: SweptTask[] = [];
  for (const [roomId, tasks] of byRoom) {
    const { result } = await dispatcher.runSystem(roomId, "tasks.sweep_leases", async (ctx) => {
      const released: SweptTask[] = [];
      const events = [];
      for (const c of tasks) {
        // Re-check under the lock: the owner may have heartbeated or released it meanwhile.
        const { rows } = await ctx.client.query<{ version: number }>(
          `UPDATE tasks SET status = 'OPEN', owner_id = NULL, blocked_reason = NULL,
                            lease_expires_at = NULL, version = version + 1,
                            updated_at = clock_timestamp()
           WHERE id = $1 AND room_id = $2 AND owner_id = $3
             AND status IN ('CLAIMED', 'IN_PROGRESS', 'BLOCKED')
             AND lease_expires_at IS NOT NULL AND lease_expires_at <= $4
           RETURNING version`,
          [c.id, roomId, c.owner_id, now],
        );
        const row = rows[0];
        if (!row) continue;
        released.push({ room_id: roomId, task_id: c.id, previous_owner_id: c.owner_id });
        events.push({
          type: "task.lease_expired" as const,
          actor_id: SYSTEM_ACTOR,
          payload: { task_id: c.id, previous_owner_id: c.owner_id, version: row.version },
        });
      }
      return { result: released, events };
    });
    swept.push(...result);
  }
  return swept;
}
