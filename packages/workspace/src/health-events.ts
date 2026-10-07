import type { Pool } from "@crossover/db";
import type { Dispatcher } from "@crossover/kernel";
import { deliverInbox } from "@crossover/kernel";
import type { HealthRunResult } from "./health-runner.js";

const SUMMARY_LIMIT = 500;

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

  await dispatcher.runSystem(roomId, "workspace.health", async ({ client }) => {
    const { rows: previousGreen } = await client.query<{ revision: number | string }>(
      `SELECT revision FROM health_runs
       WHERE room_id = $1 AND status = 'GREEN' AND revision <= $2
       ORDER BY revision DESC, created_at DESC LIMIT 1`,
      [roomId, revision],
    );
    const lastGreenRevision = previousGreen[0] ? Number(previousGreen[0].revision) : null;
    const summary = result.log
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-8)
      .join("\n")
      .slice(0, SUMMARY_LIMIT);
    const payload: Record<string, unknown> = {
      revision,
      status: result.status,
      duration: result.durationMs,
      failing_summary: summary || null,
      log_ref: runId,
    };
    if (result.status === "RED") payload.last_green_revision = lastGreenRevision;

    let inboxCount = 0;
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
        await deliverInbox(client, roomId, author_id, {
          kind: "CONFLICT",
          ref: { kind: "health_run", id: runId },
          summary: `Health check failed at workspace revision ${revision}; your ChangeSet is in the suspect range.`,
        });
        inboxCount += 1;
      }
    }

    return {
      result: { inboxCount, lastGreenRevision },
      events: [{ type: "workspace.health", actor_id: "system", payload }],
    };
  });
}
