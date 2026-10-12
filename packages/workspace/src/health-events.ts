import type { Pool } from "@crossover/db";
import type { Dispatcher, EmittedEvent } from "@crossover/kernel";
import { deliverInbox, hasLiveDeny } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { HealthRunResult } from "./health-runner.js";
export const healthGetParamsSchema = z.strictObject({ run_id: z.string().min(1).max(100) });
const LOG_TAIL_CHARS = 16 * 1024;

interface HealthRevisionRow {
  workspace_id: string;
}

/** Publish the durable result and notify authors of the exact suspect revision interval (§12.1). */
export async function publishHealthResult(
  pool: Pool,
  dispatcher: Dispatcher,
  roomId: string,
  revision: number,
  runId: string,
  result: HealthRunResult,
): Promise<void> {
  const { rows } = await pool.query<HealthRevisionRow>(
    `SELECT w.id AS workspace_id
     FROM workspaces w
     JOIN workspace_revisions r ON r.workspace_id = w.id AND r.room_id = w.room_id
     WHERE w.room_id = $1 AND r.revision = $2`,
    [roomId, revision],
  );
  const current = rows[0];
  if (!current) return;

  await dispatcher.runSystem(
    roomId,
    "workspace.health",
    async ({ client }) => {
      const { rows: previousGreen } = await client.query<{ revision: number | string }>(
        `SELECT revision FROM health_runs
       WHERE room_id = $1 AND status = 'GREEN' AND revision <= $2
       ORDER BY revision DESC, created_at DESC LIMIT 1`,
        [roomId, revision],
      );
      const lastGreenRevision = previousGreen[0] ? Number(previousGreen[0].revision) : null;
      const payload: Record<string, unknown> = {
        revision,
        status: result.status,
        duration: result.durationMs,
        log_ref: runId,
      };
      if (result.status === "RED") payload.last_green_revision = lastGreenRevision;

      let inboxCount = 0;
      const inboxEvents: (EmittedEvent & { actor_id: string })[] = [];
      const suspectIds: string[] = [];
      if (result.status === "RED") {
        const { rows: suspects } = await client.query<{ author_id: string }>(
          `SELECT DISTINCT c.actor_id AS author_id
         FROM workspace_revisions r
         JOIN changesets c ON c.id = r.changeset_id
                          AND c.workspace_id = r.workspace_id AND c.room_id = r.room_id
         JOIN participants p ON p.id = c.actor_id AND p.room_id = c.room_id
         WHERE r.room_id = $1 AND r.workspace_id = $2
           AND r.revision <= $3 AND ($4::bigint IS NULL OR r.revision > $4)
           AND p.status <> 'REMOVED'
         ORDER BY author_id`,
          [roomId, current.workspace_id, revision, lastGreenRevision],
        );
        for (const { author_id } of suspects) {
          await deliverInbox(
            client,
            roomId,
            author_id,
            {
              kind: "HEALTH_RED",
              ref: { kind: "health_run", id: runId },
              summary: `Health check failed at workspace revision ${revision}; your ChangeSet is in the suspect range.`,
              author_id: "system",
            },
            inboxEvents,
          );
          inboxCount += 1;
          suspectIds.push(author_id);
        }
        // Whose ChangeSets are in the suspect range travels with the event (subscribers' relevance).
        payload["suspect_ids"] = suspectIds;
      }

      return {
        result: { inboxCount, lastGreenRevision },
        events: [{ type: "workspace.health", actor_id: "system", payload }, ...inboxEvents],
      };
    },
    // A frozen room records no new health events (the run itself stays in health_runs).
    { whenFrozen: () => ({ inboxCount: 0, lastGreenRevision: null }) },
  );
}

/** Register the scoped-safe health log read (§12.1); scoped readers receive status only. */
export function registerWorkspaceHealthReads(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "workspace.health.get",
    // Status is room-readable; the more sensitive log is separately gated below.
    action: "room.read",
    perPathAuthorize: true,
    mutating: false,
    view: "participant",
    params: healthGetParamsSchema,
    execute: async (ctx, { run_id }) => {
      const { rows } = await ctx.client.query<{
        revision: string;
        status: string;
        duration_ms: number;
        log: string;
      }>(
        `SELECT revision, status, duration_ms, log
         FROM health_runs WHERE room_id = $1 AND id = $2`,
        [ctx.room_id, run_id],
      );
      const run = rows[0];
      if (!run) throw new CrossoverError("NOT_FOUND", "Health run not found");
      const response: Record<string, unknown> = {
        run_id,
        revision: Number(run.revision),
        status: run.status,
        duration: run.duration_ms,
      };
      let canReadLog = false;
      const { rows: identity } = await ctx.client.query<{ authority: string }>(
        "SELECT authority FROM participants WHERE id = $1 AND room_id = $2",
        [ctx.principal.participant_id, ctx.room_id],
      );
      if (identity[0]?.authority === "OWNER" || identity[0]?.authority === "ADMIN") {
        canReadLog = true;
      } else {
        try {
          // No resource scope means this requires an unscoped workspace.read capability.
          await ctx.authorize("workspace.read");
          canReadLog = !(await hasLiveDeny(
            ctx.client,
            ctx.room_id,
            ctx.principal.participant_id,
            "workspace.read",
          ));
        } catch (error) {
          if (
            !(error instanceof CrossoverError) ||
            !["FORBIDDEN", "APPROVAL_REQUIRED"].includes(error.code)
          )
            throw error;
        }
      }
      if (canReadLog) {
        response.summary = run.log
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-8)
          .join("\n")
          .slice(0, 500);
        response.log_tail = run.log.slice(-LOG_TAIL_CHARS);
      }
      return { response };
    },
  });
}
