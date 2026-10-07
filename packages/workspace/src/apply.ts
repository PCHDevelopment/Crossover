import type { CommandContext, CommandResult, Dispatcher, EmittedEvent } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { changesetParamsSchema, type ChangesetParams } from "./changeset.js";
import { classifyConflicts, type ClassifiedConflict } from "./conflicts.js";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { merge } from "./merge.js";
import type { Operation } from "./operations.js";
import { treeChanges } from "./tree-changes.js";
import { updateCanonicalRef } from "./reconcile.js";
import { registerWorkspaceReads } from "./reads.js";
import { registerWorkspaceHistory } from "./history.js";
import { registerWorkspaceBlame } from "./blame.js";
import { registerWorkspaceSearch } from "./search.js";
import { refreshSearchTree } from "./search-tree.js";
import { registerWorkspaceConflictReads } from "./conflict-reads.js";
import { escalateOpenConflict, registerWorkspaceConflictActions } from "./conflict-actions.js";
import { registerWorkspaceHealthReads } from "./health-events.js";

export interface WorkspaceCommandDeps {
  /** Failure is reported after commit; startup reconcileRef restores the DB-authoritative head. */
  updateCanonicalRef?: (repo: string, commit: string, expected: string) => Promise<void>;
  /** A failed checkout refresh is repaired by the next search against the committed DB head. */
  refreshSearchTree?: (repo: string, commit: string, previousCommit?: string) => Promise<void>;
  /** Merge engine seam for deterministic conflict-policy checks. */
  merge?: typeof merge;
  /** Schedule health for an applied head after its transaction commits. */
  scheduleHealthCheck?: (roomId: string, revision: number) => void;
}

export type ApplyResponse =
  | { status: "APPLIED"; changeset_id: string; applied_revision: number }
  | {
      status: "CONFLICT";
      changeset_id: string;
      conflict_id: string;
      conflicts: ConflictResponse[];
      counterparty_changesets: string[];
    };

export type ConflictResponse =
  ClassifiedConflict | { path: null; kind: ClassifiedConflict["kind"]; reason: "unauthorized" };

/** Register §10.3 application; all state and events share the dispatcher transaction. */
export function registerWorkspaceCommands(
  dispatcher: Dispatcher,
  deps: WorkspaceCommandDeps = {},
): void {
  dispatcher.registerCommand({
    method: "workspace.apply_changeset",
    action: "workspace.write",
    // Authorizes every touched path, and every path a merge changes (below).
    perPathAuthorize: true,
    mutating: true,
    params: changesetParamsSchema,
    execute: (ctx, params) => apply(ctx, params, deps),
  });
  registerWorkspaceReads(dispatcher);
  registerWorkspaceHistory(dispatcher);
  registerWorkspaceBlame(dispatcher);
  registerWorkspaceSearch(dispatcher);
  registerWorkspaceConflictReads(dispatcher);
  registerWorkspaceConflictActions(dispatcher);
  registerWorkspaceHealthReads(dispatcher);
}

async function apply(
  ctx: CommandContext,
  params: ChangesetParams,
  deps: WorkspaceCommandDeps,
): Promise<CommandResult<ApplyResponse>> {
  const { client, room_id } = ctx;
  const operations = params.operations.map((op): Operation =>
    op.type === "rename"
      ? {
          type: "rename",
          from: op.from,
          to: op.to,
          ...(op.content === undefined ? {} : { content: op.content }),
          ...(op.encoding === undefined ? {} : { encoding: op.encoding }),
        }
      : op,
  );
  const touched = new Set(
    operations.flatMap((op) => (op.type === "rename" ? [op.from, op.to] : [op.path])),
  );
  for (const path of touched) await ctx.authorize("workspace.write", { path });
  const workspace = await client.query<{ id: string; repo_path: string }>(
    "SELECT id, repo_path FROM workspaces WHERE room_id = $1 FOR UPDATE",
    [room_id],
  );
  const ws = workspace.rows[0];
  if (!ws) throw new CrossoverError("NOT_FOUND", "Workspace not provisioned");
  let resolution:
    | {
        conflictId: string;
        originalChangesetId: string;
        status: string;
        submitterId: string;
        attempts: number;
        ownerId: string;
        leadParticipantId: string | null;
      }
    | undefined;
  let escalationEvent: EmittedEvent | undefined;
  if (params.conflict_id) {
    const { rows } = await client.query<{
      id: string;
      status: string;
      attempts: number;
      submitter_id: string;
      changeset_id: string;
      owner_id: string;
      lead_participant_id: string | null;
    }>(
      `SELECT c.id, c.status, c.attempts, c.submitter_id, c.changeset_id,
              r.owner_id, r.lead_participant_id
       FROM conflicts c JOIN rooms r ON r.id = c.room_id
       WHERE c.id = $1 AND c.room_id = $2 AND c.workspace_id = $3
       FOR UPDATE OF c`,
      [params.conflict_id, room_id, ws.id],
    );
    const conflict = rows[0];
    if (!conflict) throw new CrossoverError("NOT_FOUND", "Conflict not found");
    if (conflict.status !== "OPEN" && conflict.status !== "ESCALATED")
      throw new CrossoverError("CONFLICT_VERSION", "Conflict is no longer open", {
        details: { status: conflict.status },
      });
    if (
      ctx.principal.participant_id !== conflict.submitter_id &&
      ctx.principal.participant_id !== conflict.lead_participant_id &&
      ctx.principal.participant_id !== conflict.owner_id
    )
      throw new CrossoverError(
        "FORBIDDEN",
        "Only the submitter, lead, or owner may resolve a conflict",
      );
    resolution = {
      conflictId: conflict.id,
      originalChangesetId: conflict.changeset_id,
      status: conflict.status,
      submitterId: conflict.submitter_id,
      attempts: conflict.attempts,
      ownerId: conflict.owner_id,
      leadParticipantId: conflict.lead_participant_id,
    };
  }
  const headRow = await client.query<{ revision: string; commit_sha: string }>(
    `SELECT revision, commit_sha FROM workspace_revisions
     WHERE room_id = $1 AND workspace_id = $2 ORDER BY revision DESC LIMIT 1`,
    [room_id, ws.id],
  );
  const baseRow = await client.query<{ commit_sha: string }>(
    `SELECT commit_sha FROM workspace_revisions
     WHERE room_id = $1 AND workspace_id = $2 AND revision = $3`,
    [room_id, ws.id, params.base_workspace_revision],
  );
  const head = headRow.rows[0];
  const base = baseRow.rows[0];
  if (!head || !base) throw new CrossoverError("VALIDATION", "Unknown workspace revision");
  const revision = Number(head.revision) + 1;
  if (!Number.isSafeInteger(revision))
    throw new CrossoverError("VALIDATION", "Workspace revision limit reached");
  const id = newId("cs");
  await client.query(
    `INSERT INTO changesets (id, workspace_id, room_id, actor_id, idempotency_key, source,
     task_id, conflict_id, message, base_workspace_revision, base_file_revisions, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      ws.id,
      room_id,
      ctx.principal.participant_id,
      ctx.idempotency_key,
      params.source,
      params.task_id ?? null,
      params.conflict_id ?? null,
      params.message,
      params.base_workspace_revision,
      JSON.stringify(params.base_file_revisions),
      JSON.stringify({ operations }),
    ],
  );
  const candidate = await materialize(ws.repo_path, base.commit_sha, operations);
  const result = await (deps.merge ?? merge)(
    ws.repo_path,
    base.commit_sha,
    head.commit_sha,
    candidate,
  );
  if (!result.clean) {
    const classified = await classifyConflicts(ws.repo_path, result);
    const conflicts: ConflictResponse[] = [];
    let allConflictsAuthorized = true;
    for (const conflict of classified) {
      let authorized = true;
      for (const path of new Set([
        conflict.path,
        ...conflict.messages.flatMap((message) => message.paths),
      ])) {
        try {
          await ctx.authorize("workspace.write", { path });
        } catch (error) {
          if (!(error instanceof CrossoverError) || error.code !== "FORBIDDEN") throw error;
          authorized = false;
        }
      }
      if (authorized) {
        conflicts.push(conflict);
      } else {
        allConflictsAuthorized = false;
        conflicts.push({ path: null, kind: conflict.kind, reason: "unauthorized" });
      }
    }
    const { rows: counterparties } = await client.query<{ id: string }>(
      `SELECT cs.id FROM changesets cs
       WHERE cs.room_id = $1 AND cs.workspace_id = $2 AND cs.status = 'APPLIED'
         AND cs.applied_revision > $3 AND cs.applied_revision <= $4
         AND EXISTS (
           SELECT 1 FROM file_revisions fr
           WHERE fr.room_id = cs.room_id AND fr.workspace_id = cs.workspace_id
             AND fr.workspace_revision = cs.applied_revision AND fr.path = ANY($5::text[])
         )
       ORDER BY cs.applied_revision, cs.created_at, cs.id`,
      [
        room_id,
        ws.id,
        params.base_workspace_revision,
        Number(head.revision),
        [
          ...new Set(
            classified.flatMap((conflict) => [
              conflict.path,
              ...conflict.messages.flatMap((message) => message.paths),
            ]),
          ),
        ],
      ],
    );
    const counterpartyChangesets = counterparties.map(({ id: counterpartyId }) => counterpartyId);
    const conflictId = resolution?.conflictId ?? newId("conf");
    if (resolution) {
      const { rows: updatedConflicts } = await client.query<{ attempts: number }>(
        `UPDATE conflicts SET attempts = attempts + 1,
         head_revision_at_detection = $3, files = $4, counterparty_changesets = $5
         WHERE id = $1 AND room_id = $2
         RETURNING attempts`,
        [
          conflictId,
          room_id,
          head.revision,
          JSON.stringify(classified),
          JSON.stringify(counterpartyChangesets),
        ],
      );
      const attempts = updatedConflicts[0]?.attempts ?? resolution.attempts + 1;
      if (attempts >= 2) {
        escalationEvent = await escalateOpenConflict(
          client,
          room_id,
          {
            id: resolution.conflictId,
            status: resolution.status,
            changeset_id: resolution.originalChangesetId,
            submitter_id: resolution.submitterId,
            attempts,
            owner_id: resolution.ownerId,
            lead_participant_id: resolution.leadParticipantId,
          },
          "attempts",
        );
      }
    } else {
      await client.query(
        `INSERT INTO conflicts (id, workspace_id, room_id, changeset_id, submitter_id,
         base_revision, head_revision_at_detection, files, counterparty_changesets)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          conflictId,
          ws.id,
          room_id,
          id,
          ctx.principal.participant_id,
          params.base_workspace_revision,
          head.revision,
          JSON.stringify(classified),
          JSON.stringify(counterpartyChangesets),
        ],
      );
    }
    await client.query(
      `UPDATE changesets SET status = 'CONFLICT', conflict_id = $3,
       payload = payload || jsonb_build_object(
         'conflicts', $4::jsonb, 'counterparty_changesets', $5::jsonb
       )
       WHERE room_id = $1 AND id = $2`,
      [room_id, id, conflictId, JSON.stringify(classified), JSON.stringify(counterpartyChangesets)],
    );
    return {
      response: {
        status: "CONFLICT" as const,
        changeset_id: id,
        conflict_id: conflictId,
        conflicts,
        counterparty_changesets: allConflictsAuthorized ? counterpartyChangesets : [],
      },
      events: resolution
        ? escalationEvent
          ? [escalationEvent]
          : []
        : [
            {
              type: "workspace.conflict.created" as const,
              payload: {
                conflict_id: conflictId,
                changeset_id: id,
                submitter_id: ctx.principal.participant_id,
                file_count: classified.length,
                kinds: classified.map(({ kind }) => kind),
                counterparty_count: counterpartyChangesets.length,
              },
            },
          ],
    };
  }
  const changedFiles = await treeChanges(ws.repo_path, head.commit_sha, result.tree);
  // Git may carry a stale edit through a head-side rename to a new path.
  for (const { path } of changedFiles)
    if (!touched.has(path)) await ctx.authorize("workspace.write", { path });
  const options = { gitDir: ws.repo_path, timeoutMs: 10_000 };
  const commit = (
    await git(["commit-tree", result.tree, "-p", head.commit_sha], {
      ...options,
      input: params.message + "\n",
      env: {
        GIT_AUTHOR_NAME: "Crossover",
        GIT_AUTHOR_EMAIL: "system@crossover.local",
        GIT_COMMITTER_NAME: "Crossover",
        GIT_COMMITTER_EMAIL: "system@crossover.local",
      },
    })
  ).stdout.trim();
  await client.query(
    `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha, changeset_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [ws.id, room_id, revision, commit, id],
  );
  for (const { path, blob } of changedFiles) {
    await client.query(
      `INSERT INTO file_revisions (workspace_id, room_id, path, revision, workspace_revision, blob_sha, actor_id)
       SELECT $1,$2,$3,coalesce(max(revision),0)+1,$4,$5,$6 FROM file_revisions
       WHERE workspace_id = $1 AND room_id = $2 AND path = $3`,
      [ws.id, room_id, path, revision, blob, ctx.principal.participant_id],
    );
  }
  await client.query(
    `UPDATE changesets SET status = 'APPLIED', applied_revision = $3, applied_at = now()
     WHERE room_id = $1 AND id = $2`,
    [room_id, id, revision],
  );
  if (resolution) {
    await client.query(
      `UPDATE conflicts SET status = 'RESOLVED', resolver_id = $3,
       resolution_changeset_id = $4, resolved_at = clock_timestamp()
       WHERE id = $1 AND room_id = $2`,
      [resolution.conflictId, room_id, ctx.principal.participant_id, id],
    );
    await client.query(
      `UPDATE changesets SET status = 'REJECTED', rejection_reason = 'SUPERSEDED'
       WHERE room_id = $1 AND id = $2`,
      [room_id, resolution.originalChangesetId],
    );
  }
  ctx.afterCommit(async () => {
    await (deps.updateCanonicalRef ?? updateCanonicalRef)(ws.repo_path, commit, head.commit_sha);
  });
  ctx.afterCommit(async () => {
    if (deps.refreshSearchTree) await deps.refreshSearchTree(ws.repo_path, commit, head.commit_sha);
    else await refreshSearchTree(ws.repo_path, commit, head.commit_sha);
  });
  if (deps.scheduleHealthCheck) ctx.afterCommit(() => deps.scheduleHealthCheck!(room_id, revision));
  return {
    response: { status: "APPLIED" as const, changeset_id: id, applied_revision: revision },
    events: [
      {
        type: "workspace.changeset.applied" as const,
        payload: { changeset_id: id, applied_revision: revision },
      },
      ...(resolution
        ? [
            {
              type: "workspace.conflict.resolved" as const,
              payload: {
                conflict_id: resolution.conflictId,
                changeset_id: resolution.originalChangesetId,
                resolution_changeset_id: id,
                resolver_id: ctx.principal.participant_id,
              },
            },
          ]
        : []),
    ],
  };
}
