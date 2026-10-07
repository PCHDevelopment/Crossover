import { loadAuthorKinds, provenanceOf, type Dispatcher } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";

export const DEFAULT_CHECKPOINT_PAGE = 50;
export const MAX_CHECKPOINT_PAGE = 100;

export const checkpointsCreateParams = z.strictObject({
  message: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((v) => !v.includes("\0"), "Text contains NUL"),
  /** Mark the revision although its health isn't green. The owner only. */
  override: z.boolean().default(false),
});

export const checkpointsListParams = z.strictObject({
  limit: z.number().int().min(1).max(MAX_CHECKPOINT_PAGE).default(DEFAULT_CHECKPOINT_PAGE),
  /** Continue after this checkpoint id (the last of the previous page). */
  after: z.string().min(1).max(100).optional(),
});

type HealthStatus = "GREEN" | "RED" | "ERROR" | "PENDING";

interface Row {
  id: string;
  revision: string;
  message: string;
  created_by: string;
  health_status: HealthStatus | null;
  overridden: boolean;
  created_at: Date;
}

const COLUMNS = "id, revision, message, created_by, health_status, overridden, created_at";

const view = (r: Row) => ({
  id: r.id,
  revision: Number(r.revision),
  message: r.message,
  created_by: r.created_by,
  health_status: r.health_status,
  overridden: r.overridden,
  created_at: r.created_at.toISOString(),
});

/**
 * Register `checkpoints.create` and `checkpoints.list` (T804, §24.3).
 *
 * - **create** marks the workspace's current head revision (lead or owner). When the room has a
 *   health command, the head's health must be GREEN: a red or errored run, or none yet, is
 *   `VALIDATION` (`health_red` / `health_error` / `health_pending`), unless the owner passes
 *   `override: true` (anyone else doing so is `FORBIDDEN`). The checkpoint records the health it
 *   was made with and whether it was overridden. One checkpoint per revision; a workspace with no
 *   revision past 0 has nothing to mark. Emits `checkpoint.created`.
 * - **list** returns the room's checkpoints, oldest first, paged with `after`; every member sees
 *   them alike. Each carries who made it, labeled as a participant's words (§16.5).
 */
export function registerCheckpointCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "checkpoints.create",
    mutating: true,
    params: checkpointsCreateParams,
    execute: async (ctx, p) => {
      const { client, room_id } = ctx;
      if (p.override && ctx.principal.authority !== "OWNER") {
        throw new CrossoverError("FORBIDDEN", "Only the owner can override the health check", {
          details: { reason: "owner_only_override" },
        });
      }
      // Lock the workspace (as every apply does) so the head can't move under the check.
      const { rows: locked } = await client.query<{ id: string }>(
        "SELECT id FROM workspaces WHERE room_id = $1 FOR UPDATE",
        [room_id],
      );
      const { rows: heads } = await client.query<{
        workspace_id: string;
        revision: string;
        health_command: string | null;
      }>(
        `SELECT $2::text AS workspace_id,
                (SELECT coalesce(max(revision), 0) FROM workspace_revisions
                 WHERE room_id = $1 AND workspace_id = $2) AS revision,
                (SELECT settings ->> 'health_command' FROM rooms WHERE id = $1) AS health_command`,
        [room_id, locked[0]?.id ?? ""],
      );
      const head = locked[0] ? heads[0] : undefined;
      if (!head) throw new CrossoverError("NOT_FOUND", "Workspace not provisioned");
      const revision = Number(head.revision);
      if (revision < 1) {
        throw new CrossoverError("VALIDATION", "The workspace has no revision to mark yet", {
          details: { reason: "empty_workspace" },
        });
      }
      const { rowCount: already } = await client.query(
        "SELECT 1 FROM checkpoints WHERE room_id = $1 AND revision = $2",
        [room_id, revision],
      );
      if (already) {
        throw new CrossoverError("VALIDATION", "This revision already has a checkpoint", {
          details: { reason: "already_checkpointed", revision },
        });
      }

      let health: HealthStatus | null = null;
      if (head.health_command?.trim()) {
        const { rows } = await client.query<{ status: "GREEN" | "RED" | "ERROR" }>(
          `SELECT status FROM health_runs WHERE room_id = $1 AND revision = $2
           ORDER BY created_at DESC, id DESC LIMIT 1`,
          [room_id, revision],
        );
        health = rows[0]?.status ?? "PENDING";
        if (health !== "GREEN" && !p.override) {
          throw new CrossoverError(
            "VALIDATION",
            health === "PENDING"
              ? "No health run covers the head yet"
              : health === "RED"
                ? "The head's health run is red"
                : "The head's health run failed",
            {
              details: {
                reason: `health_${health.toLowerCase()}`,
                revision,
                owner_may_override: true,
              },
            },
          );
        }
      }
      const overridden = health !== null && health !== "GREEN";
      const id = newId("ckpt");
      const { rows } = await client.query<Row>(
        `INSERT INTO checkpoints (id, room_id, workspace_id, revision, message, created_by,
                                  health_status, overridden)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
        [
          id,
          room_id,
          head.workspace_id,
          revision,
          p.message,
          ctx.principal.participant_id,
          health,
          overridden,
        ],
      );
      const checkpoint = view(rows[0]!);
      return {
        response: checkpoint,
        events: [
          {
            type: "checkpoint.created" as const,
            payload: {
              checkpoint_id: id,
              revision,
              created_by: checkpoint.created_by,
              health_status: health,
              overridden,
            },
          },
        ],
      };
    },
  });

  dispatcher.registerCommand({
    method: "checkpoints.list",
    action: "checkpoints.read",
    mutating: false,
    view: "none",
    view_reason: "checkpoints are workspace-level marks, visible to every member alike",
    params: checkpointsListParams,
    execute: async (ctx, p) => {
      const values: unknown[] = [ctx.room_id, p.limit + 1];
      let where = "room_id = $1";
      if (p.after !== undefined) {
        const { rows } = await ctx.client.query<{ ts: string }>(
          `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
           FROM checkpoints WHERE id = $1 AND room_id = $2`,
          [p.after, ctx.room_id],
        );
        if (!rows[0]) throw new CrossoverError("NOT_FOUND", `Checkpoint ${p.after} not found`);
        values.push(rows[0].ts, p.after);
        where += ` AND (created_at, id) > ($3::timestamptz, $4)`;
      }
      const { rows } = await ctx.client.query<Row>(
        `SELECT ${COLUMNS} FROM checkpoints WHERE ${where}
         ORDER BY created_at, id COLLATE "C" LIMIT $2`,
        values,
      );
      const page = rows.slice(0, p.limit);
      const kinds = await loadAuthorKinds(
        ctx.client,
        ctx.room_id,
        page.map((r) => r.created_by),
      );
      return {
        response: {
          checkpoints: page.map((r) => ({
            ...view(r),
            provenance: provenanceOf(kinds, r.created_by),
          })),
          has_more: rows.length > p.limit,
        },
      };
    },
  });
}
