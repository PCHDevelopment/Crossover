import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { CommandContext, Dispatcher } from "../../dispatcher.js";
import { loadActor } from "./create-update.js";
import { loadTask, TASK_COLUMNS, taskView, versionConflict, type TaskRow } from "./task.js";

/** An agent's claim lasts this long unless renewed (§8.4). */
export const AGENT_LEASE_MINUTES = 15;

export const taskVersionParams = z.strictObject({
  task_id: z.string().min(1).max(100),
  /** The version you last saw; a stale one is `CONFLICT_VERSION`. */
  expected_version: z.number().int().min(1),
});

/** The lease an owner gets when they take a task: agents expire, humans never (§8.4). */
export const leaseSql = (ownerKindParam: string) =>
  `CASE WHEN ${ownerKindParam} = 'AGENT'
        THEN clock_timestamp() + make_interval(mins => ${AGENT_LEASE_MINUTES}) END`;

/**
 * Register the task lifecycle commands (T304 onwards, §8.2, §8.3). Each is one conditional
 * `UPDATE … WHERE version = $expected AND status = …` after the task row is locked, so exactly
 * one of several racing callers succeeds and the rest get `CONFLICT_VERSION` carrying the task
 * as it is now.
 */
export function registerTaskLifecycleCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "tasks.claim",
    mutating: true,
    params: taskVersionParams,
    execute: async (ctx, p) => {
      const task = await loadTask(ctx.client, ctx.room_id, p.task_id, true);
      // A claim only wins against exactly the open task the caller saw.
      if (task.status !== "OPEN" || task.version !== p.expected_version)
        throw versionConflict(task);
      const actor = await loadActor(ctx);
      return takeTask(ctx, task, actor.id, "task.claimed");
    },
  });

  dispatcher.registerCommand({
    method: "tasks.assign",
    mutating: true,
    params: taskVersionParams.extend({ participant_id: z.string().min(1).max(100) }),
    execute: async (ctx, p) => {
      const task = await loadTask(ctx.client, ctx.room_id, p.task_id, true);
      if (task.status !== "OPEN" || task.version !== p.expected_version)
        throw versionConflict(task);
      const { rows } = await ctx.client.query<{ status: string }>(
        "SELECT status FROM participants WHERE id = $1 AND room_id = $2",
        [p.participant_id, ctx.room_id],
      );
      const status = rows[0]?.status;
      if (status === undefined) {
        throw new CrossoverError("NOT_FOUND", `Participant ${p.participant_id} not found`);
      }
      if (status !== "ACTIVE") {
        throw new CrossoverError(
          "VALIDATION",
          `Participant ${p.participant_id} is ${status}, not active`,
          {
            details: { participant_id: p.participant_id, status },
          },
        );
      }
      return takeTask(ctx, task, p.participant_id, "task.assigned", {
        assigned_by: ctx.principal.participant_id,
      });
    },
  });
}

/** Mark `task` as owned by `ownerId` (claim or assign): `OPEN → CLAIMED`, version + 1, lease for agents. */
export async function takeTask(
  ctx: CommandContext,
  task: TaskRow,
  ownerId: string,
  eventType: "task.claimed" | "task.assigned",
  extra: Record<string, unknown> = {},
) {
  const { rows } = await ctx.client.query<TaskRow>(
    `UPDATE tasks t SET status = 'CLAIMED', owner_id = p.id, version = t.version + 1,
                        lease_expires_at = ${leaseSql("p.kind")}, updated_at = clock_timestamp()
     FROM participants p
     WHERE t.id = $1 AND t.room_id = $2 AND t.status = 'OPEN' AND t.version = $3
       AND p.id = $4 AND p.room_id = $2
     RETURNING ${TASK_COLUMNS.split(",")
       .map((c) => `t.${c.trim()}`)
       .join(", ")}`,
    [task.id, ctx.room_id, task.version, ownerId],
  );
  const updated = rows[0];
  if (!updated) {
    const current = await loadTask(ctx.client, ctx.room_id, task.id);
    if (current.status !== "OPEN" || current.version !== task.version)
      throw versionConflict(current);
    throw new CrossoverError("NOT_FOUND", `Participant ${ownerId} not found`);
  }
  return {
    response: taskView(updated),
    events: [
      {
        type: eventType,
        payload: {
          task_id: task.id,
          owner_id: ownerId,
          from_version: task.version,
          version: updated.version,
          lease_expires_at: updated.lease_expires_at?.toISOString() ?? null,
          ...extra,
        },
      },
    ],
  };
}
