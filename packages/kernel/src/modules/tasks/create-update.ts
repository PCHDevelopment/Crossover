import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import { principalKinds } from "../provenance.js";
import type { CommandContext, Dispatcher } from "../../dispatcher.js";
import {
  leaseSql,
  loadTask,
  TASK_COLUMNS,
  labelTask,
  taskView,
  versionConflict,
  type TaskRow,
} from "./task.js";

export const MAX_REQUIREMENTS = 50;
export const MAX_DEPENDENCIES = 50;

const title = z.string().trim().min(1).max(200);
const description = z.string().max(20_000);
const requirement = z.string().trim().min(1).max(1000);
const requirements = z.array(requirement).min(1).max(MAX_REQUIREMENTS);
const priority = z.number().int().min(0).max(3);
const dependencies = z.array(z.string().min(1).max(100)).max(MAX_DEPENDENCIES);
const participantId = z.string().min(1).max(100);

export const tasksCreateParams = z.strictObject({
  title,
  description: description.default(""),
  /** Explicit completion criteria: at least one. */
  requirements,
  priority: priority.optional(),
  dependencies: dependencies.optional(),
  /** Defaults to the lead when the time comes to review. */
  reviewer_id: participantId.optional(),
  /** Default: the room's `review_required_default` setting, which is true unless changed. */
  review_required: z.boolean().optional(),
});

export const tasksUpdateParams = z
  .strictObject({
    task_id: z.string().min(1).max(100),
    /** The version you last saw; a stale one is `CONFLICT_VERSION`. */
    expected_version: z.number().int().min(1),
    title: title.optional(),
    description: description.optional(),
    requirements: requirements.optional(),
    priority: priority.optional(),
    dependencies: dependencies.optional(),
    /** `null` clears it (the lead reviews). */
    reviewer_id: participantId.nullable().optional(),
    review_required: z.boolean().optional(),
    /** Lead, owner and admin only (§8.2). */
    override_dependencies: z.boolean().optional(),
  })
  .refine(
    (p) => Object.keys(p).some((k) => k !== "task_id" && k !== "expected_version"),
    "Nothing to update",
  );

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** Every dependency must be a task of this room (and not the task itself). */
async function checkDependencies(
  ctx: CommandContext,
  ids: readonly string[],
  selfId?: string,
): Promise<void> {
  if (ids.length === 0) return;
  if (selfId !== undefined && ids.includes(selfId)) {
    throw new CrossoverError("VALIDATION", "A task can't depend on itself", {
      details: { dependency: selfId },
    });
  }
  const { rows } = await ctx.client.query<{ id: string }>(
    "SELECT id FROM tasks WHERE room_id = $1 AND id = ANY($2::text[])",
    [ctx.room_id, ids],
  );
  const found = new Set(rows.map((r) => r.id));
  const unknown = ids.filter((id) => !found.has(id));
  if (unknown.length > 0) {
    throw new CrossoverError("VALIDATION", `Unknown dependency ${unknown[0]}`, {
      details: { unknown_dependencies: unknown },
    });
  }
}

/** Would making `taskId` depend on `ids` close a loop? */
async function checkNoCycle(ctx: CommandContext, taskId: string, ids: readonly string[]) {
  const { rows } = await ctx.client.query<{ id: string; dependencies: string[] }>(
    "SELECT id, dependencies FROM tasks WHERE room_id = $1",
    [ctx.room_id],
  );
  const graph = new Map(rows.map((r) => [r.id, r.dependencies]));
  const seen = new Set<string>();
  const stack = [...ids];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next === taskId) {
      throw new CrossoverError("VALIDATION", "Those dependencies would make a cycle", {
        details: { task_id: taskId },
      });
    }
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph.get(next) ?? []));
  }
}

async function checkReviewer(ctx: CommandContext, reviewerId: string): Promise<void> {
  const { rows } = await ctx.client.query<{ status: string }>(
    "SELECT status FROM participants WHERE id = $1 AND room_id = $2",
    [reviewerId, ctx.room_id],
  );
  const status = rows[0]?.status;
  if (status === undefined || status === "REMOVED") {
    throw new CrossoverError("VALIDATION", `Reviewer ${reviewerId} isn't a member of this room`, {
      details: { reviewer_id: reviewerId },
    });
  }
}

interface ActorRow {
  id: string;
  authority: "OWNER" | "ADMIN" | "MEMBER";
  role: "LEAD" | "DEVELOPER" | "REVIEWER" | "OBSERVER";
}

/** The acting participant as the database has them now (the principal is a snapshot). */
export async function loadActor(ctx: CommandContext): Promise<ActorRow> {
  const { rows } = await ctx.client.query<ActorRow>(
    "SELECT id, authority, role FROM participants WHERE id = $1 AND room_id = $2",
    [ctx.principal.participant_id, ctx.room_id],
  );
  const actor = rows[0];
  if (!actor) throw new CrossoverError("FORBIDDEN", "Not a participant of this room");
  return actor;
}

/** Lead, owner or admin: the people who manage other participants' tasks (§8.2). */
export const manages = (actor: ActorRow): boolean =>
  actor.role === "LEAD" || actor.authority === "OWNER" || actor.authority === "ADMIN";

/**
 * Register `tasks.create` and `tasks.update` (T302, §8.1, §8.3).
 *
 * `create` makes an `OPEN` task at version 1 (`task.created`). `update` changes its fields
 * under optimistic concurrency: `expected_version` must match, otherwise `CONFLICT_VERSION`
 * carries the task as it is now (`details.current`). Every dependency must be a task of the
 * room, and dependencies can't form a loop. Only the task's owner, its creator while it is
 * still open, and the lead, owner and admin may update it; a finished (`DONE`/`CANCELLED`) task
 * can't be updated.
 */
export function registerTaskCommands(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "tasks.create",
    mutating: true,
    params: tasksCreateParams,
    execute: async (ctx, p) => {
      const deps = unique(p.dependencies ?? []);
      await checkDependencies(ctx, deps);
      if (p.reviewer_id !== undefined) await checkReviewer(ctx, p.reviewer_id);

      const { rows: settings } = await ctx.client.query<{ review_required_default: unknown }>(
        "SELECT settings -> 'review_required_default' AS review_required_default FROM rooms WHERE id = $1",
        [ctx.room_id],
      );
      const reviewRequired =
        p.review_required ??
        (typeof settings[0]?.review_required_default === "boolean"
          ? settings[0].review_required_default
          : true);

      const { rows } = await ctx.client.query<TaskRow>(
        `INSERT INTO tasks (id, room_id, title, description, requirements, created_by, priority,
                            dependencies, reviewer_id, review_required)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::text[], $9, $10)
         RETURNING ${TASK_COLUMNS}`,
        [
          newId("task"),
          ctx.room_id,
          p.title,
          p.description,
          JSON.stringify(p.requirements),
          ctx.principal.participant_id,
          p.priority ?? 2,
          deps,
          p.reviewer_id ?? null,
          reviewRequired,
        ],
      );
      const task = taskView(rows[0]!);
      return {
        response: labelTask(task, principalKinds(ctx.principal)),
        events: [{ type: "task.created" as const, payload: { task } }],
      };
    },
  });

  dispatcher.registerCommand({
    method: "tasks.update",
    mutating: true,
    params: tasksUpdateParams,
    execute: async (ctx, p) => {
      const task = await loadTask(ctx.client, ctx.room_id, p.task_id, true);
      if (task.version !== p.expected_version) throw versionConflict(task);

      const actor = await loadActor(ctx);
      const mayUpdate =
        manages(actor) ||
        task.owner_id === actor.id ||
        (task.status === "OPEN" && task.created_by === actor.id);
      if (!mayUpdate) {
        throw new CrossoverError("FORBIDDEN", "Only the task's owner or the lead can update it", {
          details: { reason: "not_task_owner" },
        });
      }
      if (task.status === "DONE" || task.status === "CANCELLED") {
        throw new CrossoverError("VALIDATION", `A ${task.status} task can't be updated`, {
          details: { status: task.status },
        });
      }
      if (p.override_dependencies !== undefined && !manages(actor)) {
        throw new CrossoverError(
          "FORBIDDEN",
          "Only the lead, owner or an admin can override dependencies",
          {
            details: { reason: "override_dependencies" },
          },
        );
      }

      const deps = p.dependencies === undefined ? undefined : unique(p.dependencies);
      if (deps !== undefined) {
        await checkDependencies(ctx, deps, task.id);
        await checkNoCycle(ctx, task.id, deps);
      }
      if (p.reviewer_id) await checkReviewer(ctx, p.reviewer_id);

      const changes: Record<string, unknown> = {};
      const set: string[] = [];
      const values: unknown[] = [task.id, ctx.room_id, task.version];
      const assign = (column: string, value: unknown, cast = "") => {
        values.push(value);
        set.push(`${column} = $${values.length}${cast}`);
        changes[column] = value;
      };
      if (p.title !== undefined) assign("title", p.title);
      if (p.description !== undefined) assign("description", p.description);
      if (p.requirements !== undefined)
        assign("requirements", JSON.stringify(p.requirements), "::jsonb");
      if (p.priority !== undefined) assign("priority", p.priority);
      if (deps !== undefined) assign("dependencies", deps, "::text[]");
      if (p.reviewer_id !== undefined) assign("reviewer_id", p.reviewer_id);
      if (p.review_required !== undefined) assign("review_required", p.review_required);
      if (p.override_dependencies !== undefined) {
        assign("override_dependencies", p.override_dependencies);
      }
      if (p.requirements !== undefined) changes.requirements = p.requirements;

      // The owner working on their own task keeps an agent's claim lease alive (§8.4).
      const renew =
        task.owner_id === actor.id &&
        (task.status === "CLAIMED" || task.status === "IN_PROGRESS" || task.status === "BLOCKED")
          ? `, lease_expires_at = (SELECT ${leaseSql("p.kind")} FROM participants p WHERE p.id = tasks.owner_id AND p.room_id = tasks.room_id)`
          : "";
      const { rows } = await ctx.client.query<TaskRow>(
        `UPDATE tasks SET ${set.join(", ")}${renew}, version = version + 1, updated_at = clock_timestamp()
         WHERE id = $1 AND room_id = $2 AND version = $3
         RETURNING ${TASK_COLUMNS}`,
        values,
      );
      const updated = rows[0];
      if (!updated) throw versionConflict(await loadTask(ctx.client, ctx.room_id, task.id));
      const view = taskView(updated);
      return {
        response: view,
        events: [
          {
            type: "task.updated" as const,
            payload: {
              task_id: task.id,
              from_version: task.version,
              version: updated.version,
              owner_id: updated.owner_id,
              changes,
            },
          },
        ],
      };
    },
  });
}
