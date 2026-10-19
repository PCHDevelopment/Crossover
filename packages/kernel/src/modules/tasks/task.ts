import type { PoolClient } from "@crossover/db";
import { provenanceOf, type AuthorKinds, type Provenance } from "../provenance.js";
import { CrossoverError } from "@crossover/protocol";
import { missingEvidence, type EvidenceItem } from "./evidence.js";

export const TASK_STATUSES = [
  "OPEN",
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
  "REVIEW",
  "DONE",
  "CANCELLED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** The row as the commands see it. */
export interface TaskRow {
  id: string;
  room_id: string;
  title: string;
  description: string;
  requirements: string[];
  owner_id: string | null;
  created_by: string;
  status: TaskStatus;
  priority: number;
  dependencies: string[];
  artifacts: unknown[];
  reviewer_id: string | null;
  review_required: boolean;
  required_approvals: number;
  review_round: number;
  override_dependencies: boolean;
  blocked_reason: string | null;
  /** The latest submission's evidence (§34.3). */
  evidence: EvidenceItem[];
  lease_expires_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** What commands return and events carry: plain JSON data. */
export interface TaskView extends Omit<TaskRow, "lease_expires_at" | "created_at" | "updated_at"> {
  /** The requirement indices with no proof in `evidence`. */
  missing_evidence: number[];
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export const TASK_COLUMNS = `id, room_id, title, description, requirements, owner_id, created_by, status,
  priority, dependencies, artifacts, reviewer_id, review_required, required_approvals, review_round, override_dependencies,
  blocked_reason, evidence, lease_expires_at, version, created_at, updated_at`;

export function taskView(row: TaskRow): TaskView {
  return {
    ...row,
    missing_evidence: missingEvidence(row.requirements.length, row.evidence),
    lease_expires_at: row.lease_expires_at ? row.lease_expires_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

/** Load a task of `roomId`, or `NOT_FOUND`. `lock` takes a row lock for the transaction. */
export async function loadTask(
  client: PoolClient,
  roomId: string,
  taskId: string,
  lock = false,
): Promise<TaskRow> {
  const { rows } = await client.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1 AND room_id = $2 ${lock ? "FOR UPDATE" : ""}`,
    [taskId, roomId],
  );
  const task = rows[0];
  if (!task) throw new CrossoverError("NOT_FOUND", `Task ${taskId} not found`);
  return task;
}

/** The standard answer to a stale `expected_version`: the task as it is now. */
export function versionConflict(current: TaskRow): CrossoverError {
  return new CrossoverError("CONFLICT_VERSION", "Task was updated by another participant", {
    details: { current: taskView(current) },
  });
}

/** An agent's claim lasts this long unless renewed (§8.4). */
export const AGENT_LEASE_MINUTES = 15;

/** The lease an owner gets when they take a task: agents expire, humans never (§8.4). */
export const leaseSql = (ownerKindParam: string) =>
  `CASE WHEN ${ownerKindParam} = 'AGENT'
        THEN clock_timestamp() + make_interval(mins => ${AGENT_LEASE_MINUTES}) END`;

/**
 * Give agents' live claims a fresh lease (§22.1: claims are frozen while a participant or the
 * room is paused, so on resume the clock starts over instead of leaving them already expired).
 * `ownerId` limits it to one participant's tasks; without it, every ACTIVE agent's in the room.
 * Only claims that have a lease (an agent's `CLAIMED`/`IN_PROGRESS`/`BLOCKED` tasks) change, and
 * neither the task's version nor any event does: it is bookkeeping, not a change to the task.
 */
export async function restartAgentLeases(
  client: PoolClient,
  roomId: string,
  ownerId?: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE tasks t SET lease_expires_at = ${leaseSql("p.kind")}
     FROM participants p
     WHERE t.room_id = $1 AND p.id = t.owner_id AND p.room_id = t.room_id
       AND p.kind = 'AGENT' AND p.status = 'ACTIVE'
       AND t.status IN ('CLAIMED', 'IN_PROGRESS', 'BLOCKED') AND t.lease_expires_at IS NOT NULL
       AND ($2::text IS NULL OR t.owner_id = $2)`,
    [roomId, ownerId ?? null],
  );
  return rowCount ?? 0;
}

/** A task as a reader gets it: who wrote its description (the creator), §16.5. */
export const labelTask = <T extends { created_by: string }>(
  view: T,
  kinds: AuthorKinds,
): T & { provenance: Provenance } => ({
  ...view,
  provenance: provenanceOf(kinds, view.created_by),
});
