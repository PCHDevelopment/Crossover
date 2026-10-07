import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import type { CommandContext, Dispatcher } from "../../dispatcher.js";
import { currentLeadId, deliverInbox } from "../inbox/inbox.js";
import { loadActor, manages } from "./create-update.js";
import {
  leaseSql,
  loadTask,
  TASK_COLUMNS,
  taskView,
  versionConflict,
  type TaskRow,
  type TaskView,
} from "./task.js";

/**
 * Is the workspace healthy enough to approve `task` (§12)? The real gate (T610) runs the room's
 * health command at the reviewed revision; until then {@link alwaysGreen} lets everything through.
 */
export interface HealthGate {
  isGreenFor(task: TaskView, ctx: CommandContext): Promise<boolean>;
}

export const alwaysGreen: HealthGate = { isGreenFor: async () => true };

export interface TaskLifecycleOptions {
  healthGate?: HealthGate;
}

export const taskVersionParams = z.strictObject({
  task_id: z.string().min(1).max(100),
  /** The version you last saw; a stale one is `CONFLICT_VERSION`. */
  expected_version: z.number().int().min(1),
});

export const tasksAssignParams = taskVersionParams.extend({
  participant_id: z.string().min(1).max(100),
});

export const tasksBlockParams = taskVersionParams.extend({
  reason: z.string().trim().min(1).max(2000),
});

export const tasksReviewParams = taskVersionParams.extend({
  verdict: z.enum(["approve", "request_changes"]),
  comments: z.string().max(10_000).default(""),
  /** Lead only: approve although the health gate says the workspace is red. */
  override_health: z.boolean().optional(),
});

/**
 * Register the task lifecycle commands (T304 onwards, §8.2, §8.3). Each is one conditional
 * `UPDATE … WHERE version = $expected AND status = …` after the task row is locked, so exactly
 * one of several racing callers succeeds and the rest get `CONFLICT_VERSION` carrying the task
 * as it is now.
 */
export function registerTaskLifecycleCommands(
  dispatcher: Dispatcher,
  options: TaskLifecycleOptions = {},
): void {
  const healthGate = options.healthGate ?? alwaysGreen;
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
    params: tasksAssignParams,
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
      const taken = await takeTask(ctx, task, p.participant_id, "task.assigned", {
        assigned_by: ctx.principal.participant_id,
      });
      // Being handed work is news; assigning it to yourself is not.
      if (p.participant_id !== ctx.principal.participant_id) {
        await deliverInbox(ctx.client, ctx.room_id, p.participant_id, {
          kind: "ASSIGNMENT",
          ref: { kind: "task", id: task.id },
          summary: `Assigned to you: ${task.title}`,
        });
      }
      return taken;
    },
  });

  dispatcher.registerCommand({
    method: "tasks.start",
    mutating: true,
    params: taskVersionParams,
    execute: async (ctx, p) => {
      const task = await loadTask(ctx.client, ctx.room_id, p.task_id, true);
      const actor = await loadActor(ctx);
      if (task.owner_id !== actor.id) {
        throw new CrossoverError("FORBIDDEN", "Only the task's owner can start it", {
          details: { reason: "not_task_owner" },
        });
      }
      if (task.version !== p.expected_version) throw versionConflict(task);
      if (task.status !== "CLAIMED") {
        throw new CrossoverError("VALIDATION", `Can't start a task that is ${task.status}`, {
          details: { status: task.status },
        });
      }
      // Every dependency must be DONE, unless the lead set override_dependencies (§8.2).
      if (!task.override_dependencies && task.dependencies.length > 0) {
        const { rows } = await ctx.client.query<{ id: string; status: string }>(
          "SELECT id, status FROM tasks WHERE room_id = $1 AND id = ANY($2::text[]) AND status <> 'DONE' ORDER BY id",
          [ctx.room_id, task.dependencies],
        );
        if (rows.length > 0) {
          throw new CrossoverError(
            "VALIDATION",
            `Dependency ${rows[0]!.id} is ${rows[0]!.status}, not DONE`,
            {
              details: {
                unfinished_dependencies: rows.map((r) => ({ id: r.id, status: r.status })),
              },
            },
          );
        }
      }
      return ownerTransition(ctx, task, "IN_PROGRESS", "task.started");
    },
  });

  dispatcher.registerCommand({
    method: "tasks.block",
    mutating: true,
    params: tasksBlockParams,
    execute: async (ctx, p) => {
      const { task, actor } = await ownerOrLead(ctx, p);
      if (task.status !== "IN_PROGRESS") {
        throw new CrossoverError("VALIDATION", `Can't block a task that is ${task.status}`, {
          details: { status: task.status },
        });
      }
      return transition(ctx, task, "BLOCKED", {
        eventType: "task.blocked",
        set: "blocked_reason = $5",
        values: [p.reason],
        renewLease: task.owner_id === actor.id,
        payload: { reason: p.reason },
      });
    },
  });

  dispatcher.registerCommand({
    method: "tasks.unblock",
    mutating: true,
    params: taskVersionParams,
    execute: async (ctx, p) => {
      const { task, actor } = await ownerOrLead(ctx, p);
      if (task.status !== "BLOCKED") {
        throw new CrossoverError("VALIDATION", `Can't unblock a task that is ${task.status}`, {
          details: { status: task.status },
        });
      }
      return transition(ctx, task, "IN_PROGRESS", {
        eventType: "task.unblocked",
        set: "blocked_reason = NULL",
        renewLease: task.owner_id === actor.id,
      });
    },
  });

  dispatcher.registerCommand({
    method: "tasks.submit",
    mutating: true,
    params: taskVersionParams,
    execute: async (ctx, p) => {
      const task = await loadTask(ctx.client, ctx.room_id, p.task_id, true);
      const actor = await loadActor(ctx);
      if (task.owner_id !== actor.id) {
        throw new CrossoverError("FORBIDDEN", "Only the task's owner can submit it", {
          details: { reason: "not_task_owner" },
        });
      }
      if (task.version !== p.expected_version) throw versionConflict(task);
      if (task.status !== "IN_PROGRESS") {
        throw new CrossoverError("VALIDATION", `Can't submit a task that is ${task.status}`, {
          details: { status: task.status },
        });
      }
      // With review required it waits for a reviewer; otherwise it is done (§8.2). Either way
      // the claim no longer needs a lease: only CLAIMED, IN_PROGRESS and BLOCKED expire.
      const to = task.review_required ? "REVIEW" : "DONE";
      if (to === "REVIEW") await requestReview(ctx, task, actor.id);
      return transition(ctx, task, to, {
        eventType: "task.submitted",
        set: "lease_expires_at = NULL",
        renewLease: false,
        payload: { status: to, review_required: task.review_required },
      });
    },
  });

  dispatcher.registerCommand({
    method: "tasks.review",
    mutating: true,
    params: tasksReviewParams,
    execute: async (ctx, p) => {
      const task = await loadTask(ctx.client, ctx.room_id, p.task_id, true);
      const actor = await loadActor(ctx);
      // Nobody reviews their own task; otherwise the designated reviewer, or the lead (who
      // reviews when none is named). Owners and admins count as the lead here, as elsewhere.
      if (task.owner_id === actor.id) {
        throw new CrossoverError("FORBIDDEN", "You can't review a task you own", {
          details: { reason: "own_task" },
        });
      }
      if (task.reviewer_id !== actor.id && !manages(actor)) {
        throw new CrossoverError(
          "FORBIDDEN",
          "Only the task's reviewer or the lead can review it",
          {
            details: { reason: "not_reviewer" },
          },
        );
      }
      if (task.version !== p.expected_version) throw versionConflict(task);
      if (task.status !== "REVIEW") {
        throw new CrossoverError("VALIDATION", `Can't review a task that is ${task.status}`, {
          details: { status: task.status },
        });
      }
      if (p.override_health !== undefined && !manages(actor)) {
        throw new CrossoverError("FORBIDDEN", "Only the lead can override the health gate", {
          details: { reason: "override_health" },
        });
      }
      const approve = p.verdict === "approve";
      if (
        approve &&
        p.override_health !== true &&
        !(await healthGate.isGreenFor(taskView(task), ctx))
      ) {
        throw new CrossoverError(
          "VALIDATION",
          "The workspace isn't healthy: the health gate is red",
          {
            details: { reason: "health_gate_red" },
          },
        );
      }

      const { rows: rev } = await ctx.client.query<{ revision: string }>(
        "SELECT coalesce(max(revision), 0) AS revision FROM workspace_revisions WHERE room_id = $1",
        [ctx.room_id],
      );
      const reviewId = newId("rev");
      await ctx.client.query(
        `INSERT INTO task_reviews (id, room_id, task_id, reviewer_id, verdict, comments, revision)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          reviewId,
          ctx.room_id,
          task.id,
          actor.id,
          approve ? "APPROVE" : "REQUEST_CHANGES",
          p.comments,
          rev[0]!.revision,
        ],
      );
      const to = approve ? "DONE" : "IN_PROGRESS";
      return transition(ctx, task, to, {
        eventType: "task.reviewed",
        // Back to work: the owner's lease starts again. Done: nothing to expire.
        ...(approve ? { set: "lease_expires_at = NULL" } : {}),
        renewLease: !approve,
        payload: {
          review_id: reviewId,
          verdict: p.verdict,
          reviewer_id: actor.id,
          status: to,
          ...(p.override_health === true && approve ? { health_overridden: true } : {}),
        },
      });
    },
  });

  dispatcher.registerCommand({
    method: "tasks.release",
    mutating: true,
    params: taskVersionParams,
    execute: async (ctx, p) => {
      const { task } = await ownerOrLead(ctx, p);
      if (task.status !== "CLAIMED" && task.status !== "IN_PROGRESS" && task.status !== "BLOCKED") {
        throw new CrossoverError("VALIDATION", `Can't release a task that is ${task.status}`, {
          details: { status: task.status },
        });
      }
      // Back to the pool: nobody owns it, nothing to expire, any block is moot.
      return transition(ctx, task, "OPEN", {
        eventType: "task.released",
        set: "owner_id = NULL, blocked_reason = NULL, lease_expires_at = NULL",
        renewLease: false,
        payload: { previous_owner_id: task.owner_id },
      });
    },
  });

  dispatcher.registerCommand({
    method: "tasks.reopen",
    mutating: true,
    params: taskVersionParams,
    execute: async (ctx, p) => {
      const task = await loadTask(ctx.client, ctx.room_id, p.task_id, true);
      if (task.version !== p.expected_version) throw versionConflict(task);
      if (task.status !== "DONE") {
        throw new CrossoverError(
          "VALIDATION",
          `Only a DONE task can be reopened, this one is ${task.status}`,
          {
            details: { status: task.status },
          },
        );
      }
      // The previous owner picks it up again, with a fresh lease if they are an agent.
      return transition(ctx, task, "IN_PROGRESS", { eventType: "task.reopened", renewLease: true });
    },
  });

  dispatcher.registerCommand({
    method: "tasks.cancel",
    mutating: true,
    params: taskVersionParams,
    execute: async (ctx, p) => {
      const task = await loadTask(ctx.client, ctx.room_id, p.task_id, true);
      if (task.version !== p.expected_version) throw versionConflict(task);
      if (task.status === "DONE" || task.status === "CANCELLED") {
        throw new CrossoverError("VALIDATION", `Can't cancel a task that is ${task.status}`, {
          details: { status: task.status },
        });
      }
      return transition(ctx, task, "CANCELLED", {
        eventType: "task.cancelled",
        set: "lease_expires_at = NULL",
        renewLease: false,
        payload: { previous_status: task.status },
      });
    },
  });
}

/** Lock the task, require the caller to be its owner or the lead (owner/admin too), check the version. */
async function ownerOrLead(ctx: CommandContext, p: { task_id: string; expected_version: number }) {
  const task = await loadTask(ctx.client, ctx.room_id, p.task_id, true);
  const actor = await loadActor(ctx);
  if (task.owner_id !== actor.id && !manages(actor)) {
    throw new CrossoverError("FORBIDDEN", "Only the task's owner or the lead can do that", {
      details: { reason: "not_task_owner" },
    });
  }
  if (task.version !== p.expected_version) throw versionConflict(task);
  return { task, actor };
}

interface TransitionOptions {
  eventType:
    | "task.started"
    | "task.blocked"
    | "task.unblocked"
    | "task.submitted"
    | "task.reviewed"
    | "task.released"
    | "task.reopened"
    | "task.cancelled";
  /** Extra `SET` assignments; their values are `$5, $6, …` in `values`. */
  set?: string;
  values?: unknown[];
  /** Renew an agent owner's lease (§8.4): when the owner is the one acting. */
  renewLease: boolean;
  payload?: Record<string, unknown>;
}

/** Move `task` to `to` (version + 1) under the version the caller saw; `CONFLICT_VERSION` if it moved. */
async function transition(
  ctx: CommandContext,
  task: TaskRow,
  to: TaskRow["status"],
  o: TransitionOptions,
) {
  const { rows } = await ctx.client.query<TaskRow>(
    `UPDATE tasks t SET status = $4, version = t.version + 1, updated_at = clock_timestamp()
            ${o.renewLease ? `, lease_expires_at = (SELECT ${leaseSql("p.kind")} FROM participants p WHERE p.id = t.owner_id AND p.room_id = t.room_id)` : ""}
            ${o.set ? `, ${o.set}` : ""}
     WHERE t.id = $1 AND t.room_id = $2 AND t.version = $3
     RETURNING ${TASK_COLUMNS.split(",")
       .map((c) => `t.${c.trim()}`)
       .join(", ")}`,
    [task.id, ctx.room_id, task.version, to, ...(o.values ?? [])],
  );
  const updated = rows[0];
  if (!updated) throw versionConflict(await loadTask(ctx.client, ctx.room_id, task.id));
  return {
    response: taskView(updated),
    events: [
      {
        type: o.eventType,
        payload: {
          task_id: task.id,
          from_version: task.version,
          version: updated.version,
          ...o.payload,
        },
      },
    ],
  };
}

/** Start: the owner moves `CLAIMED → IN_PROGRESS`, which renews their lease. */
const ownerTransition = (
  ctx: CommandContext,
  task: TaskRow,
  to: TaskRow["status"],
  eventType: "task.started",
) => transition(ctx, task, to, { eventType, renewLease: true });

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

/**
 * Tell whoever should review a submitted task (T403): its named reviewer if they are still in
 * the room, otherwise the lead. Nobody is told about their own submission.
 */
async function requestReview(ctx: CommandContext, task: TaskRow, submitterId: string) {
  let recipient: string | null = null;
  if (task.reviewer_id) {
    const { rows } = await ctx.client.query(
      "SELECT 1 FROM participants WHERE id = $1 AND room_id = $2 AND status <> 'REMOVED'",
      [task.reviewer_id, ctx.room_id],
    );
    if (rows.length > 0) recipient = task.reviewer_id;
  }
  recipient ??= await currentLeadId(ctx.client, ctx.room_id);
  if (recipient === null || recipient === submitterId) return;
  await deliverInbox(ctx.client, ctx.room_id, recipient, {
    kind: "REVIEW_REQUEST",
    ref: { kind: "task", id: task.id },
    summary: `Review requested: ${task.title}`,
  });
}
