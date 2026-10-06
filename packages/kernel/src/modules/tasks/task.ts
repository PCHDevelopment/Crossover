import type { PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";

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
  override_dependencies: boolean;
  blocked_reason: string | null;
  lease_expires_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** What commands return and events carry: plain JSON data. */
export interface TaskView extends Omit<TaskRow, "lease_expires_at" | "created_at" | "updated_at"> {
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export const TASK_COLUMNS = `id, room_id, title, description, requirements, owner_id, created_by, status,
  priority, dependencies, artifacts, reviewer_id, review_required, override_dependencies,
  blocked_reason, lease_expires_at, version, created_at, updated_at`;

export function taskView(row: TaskRow): TaskView {
  return {
    ...row,
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
