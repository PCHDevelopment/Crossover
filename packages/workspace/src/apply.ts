import type { CommandContext, CommandResult, Dispatcher } from "@crossover/kernel";
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

export interface WorkspaceCommandDeps {
  /** Failure is reported after commit; startup reconcileRef restores the DB-authoritative head. */
  updateCanonicalRef?: (repo: string, commit: string, expected: string) => Promise<void>;
}

export type ApplyResponse =
  | { status: "APPLIED"; changeset_id: string; applied_revision: number }
  | { status: "CONFLICT"; changeset_id: string; conflicts: ClassifiedConflict[] };

/** Register §10.3 application; all state and events share the dispatcher transaction. */
export function registerWorkspaceCommands(
  dispatcher: Dispatcher,
  deps: WorkspaceCommandDeps = {},
): void {
  dispatcher.registerCommand({
    method: "workspace.apply_changeset",
    action: "workspace.write",
    mutating: true,
    params: changesetParamsSchema,
    execute: (ctx, params) => apply(ctx, params, deps),
  });
  registerWorkspaceReads(dispatcher);
  registerWorkspaceHistory(dispatcher);
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
  const result = await merge(ws.repo_path, base.commit_sha, head.commit_sha, candidate);
  if (!result.clean) {
    const conflicts = await classifyConflicts(ws.repo_path, result);
    await client.query(
      `UPDATE changesets SET status = 'CONFLICT', payload = payload || jsonb_build_object('conflicts', $3::jsonb)
       WHERE room_id = $1 AND id = $2`,
      [room_id, id, JSON.stringify(conflicts)],
    );
    return {
      response: { status: "CONFLICT" as const, changeset_id: id, conflicts },
      events: [
        {
          type: "workspace.conflict.created" as const,
          payload: { changeset_id: id, files: conflicts },
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
  ctx.afterCommit(async () => {
    await (deps.updateCanonicalRef ?? updateCanonicalRef)(ws.repo_path, commit, head.commit_sha);
  });
  return {
    response: { status: "APPLIED" as const, changeset_id: id, applied_revision: revision },
    events: [
      {
        type: "workspace.changeset.applied" as const,
        payload: { changeset_id: id, applied_revision: revision },
      },
    ],
  };
}
