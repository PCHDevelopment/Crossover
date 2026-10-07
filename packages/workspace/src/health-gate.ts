import type { CommandContext, HealthGate } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";

interface HealthGateRow {
  health_command: string | null;
  required_revision: string | number;
  id: string | null;
  revision: string | number | null;
  status: "GREEN" | "RED" | "ERROR" | null;
}

/**
 * Gate task approval on a completed health run that covers the task's applied ChangeSets (§12).
 * Tasks without applied ChangeSets use the workspace head at their task.submitted event.
 */
export const workspaceHealthGate: HealthGate = {
  async isGreenFor(task, ctx) {
    const row = await latestApplicableHealth(ctx, task.id);
    // Rooms without a configured health command have no meaningful gate.
    if (!row.health_command?.trim()) return true;

    const latestRun =
      row.id === null || row.revision === null || row.status === null
        ? null
        : { id: row.id, revision: Number(row.revision), status: row.status };
    if (latestRun?.status === "GREEN") return true;

    const reason =
      latestRun === null
        ? "health_gate_pending"
        : latestRun.status === "RED"
          ? "health_gate_red"
          : "health_gate_error";
    const message =
      reason === "health_gate_pending"
        ? "No health run covers the task artifacts yet"
        : reason === "health_gate_red"
          ? "The latest health run covering the task artifacts is red"
          : "The latest health run covering the task artifacts failed";
    throw new CrossoverError("VALIDATION", message, {
      details: {
        reason,
        required_revision: Number(row.required_revision),
        latest_run: latestRun,
      },
    });
  },
};

async function latestApplicableHealth(ctx: CommandContext, taskId: string): Promise<HealthGateRow> {
  const { rows } = await ctx.client.query<HealthGateRow>(
    `WITH submitted AS (
       SELECT max(sequence) AS sequence
       FROM events
       WHERE room_id = $1 AND type = 'task.submitted' AND payload ->> 'task_id' = $2
     ), workspace AS (
       SELECT id FROM workspaces WHERE room_id = $1
     ), head AS (
       SELECT coalesce(max(revision), 0) AS revision
       FROM workspace_revisions WHERE room_id = $1
     ), submission_head AS (
       SELECT CASE WHEN s.sequence IS NULL THEN (SELECT revision FROM head)
                   ELSE coalesce(max((e.payload ->> 'applied_revision')::bigint), 0)
              END AS revision
       FROM submitted s
       LEFT JOIN events e ON e.room_id = $1 AND e.type = 'workspace.changeset.applied'
                         AND e.sequence < s.sequence
       GROUP BY s.sequence
     ), required AS (
       SELECT coalesce(
         (SELECT max(c.applied_revision)
          FROM changesets c
          WHERE c.room_id = $1 AND c.task_id = $2 AND c.status = 'APPLIED'
            AND c.applied_revision IS NOT NULL),
         (SELECT revision FROM submission_head)
       ) AS revision
     )
     SELECT room.settings ->> 'health_command' AS health_command,
            required.revision AS required_revision,
            run.id,
            run.revision,
            run.status
     FROM rooms room
     CROSS JOIN required
     LEFT JOIN LATERAL (
       SELECT h.id, h.revision, h.status
       FROM health_runs h
       JOIN workspace w ON w.id = h.workspace_id
       WHERE h.room_id = $1 AND h.revision >= required.revision
       ORDER BY h.revision DESC, h.created_at DESC, h.id DESC
       LIMIT 1
     ) run ON true
     WHERE room.id = $1`,
    [ctx.room_id, taskId],
  );
  const result = rows[0];
  if (!result) throw new CrossoverError("NOT_FOUND", "Room not found");
  return result;
}
