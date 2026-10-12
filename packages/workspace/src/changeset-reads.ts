import { isUtf8 } from "node:buffer";
import type { CommandContext, Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import { BINARY_SIZE, validateFileSize } from "./binary.js";
import { changesetParamsSchema } from "./changeset.js";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import type { Operation } from "./operations.js";
import { entries, pathSchema, snapshot } from "./reads.js";

const changesetGetParamsSchema = z.strictObject({
  changeset_id: z.string().min(1),
  path: pathSchema().optional(),
});

interface ChangesetRow {
  id: string;
  workspace_id: string;
  repo_path: string;
  actor_id: string;
  source: string;
  task_id: string | null;
  conflict_id: string | null;
  message: string;
  base_workspace_revision: string;
  applied_revision: string | null;
  rejection_reason: string | null;
  status: string;
  base_file_revisions: Record<string, number>;
  payload: unknown;
  created_at: Date;
  applied_at: Date | null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function touchedPaths(operations: readonly Operation[]): string[] {
  return [
    ...new Set(
      operations.flatMap((operation) =>
        operation.type === "rename" ? [operation.from, operation.to] : [operation.path],
      ),
    ),
  ].sort();
}

async function readablePaths(ctx: CommandContext, paths: readonly string[]): Promise<string[]> {
  const readable: string[] = [];
  for (const path of paths) {
    try {
      await ctx.authorize("workspace.read", { path });
      readable.push(path);
    } catch (error) {
      if (!(error instanceof CrossoverError) || error.code !== "FORBIDDEN") throw error;
    }
  }
  return readable;
}

function parseOperations(row: ChangesetRow): Operation[] {
  const payload = record(row.payload);
  const operations = changesetParamsSchema.parse({
    source: row.source,
    message: row.message,
    base_workspace_revision: Number(row.base_workspace_revision),
    base_file_revisions: row.base_file_revisions,
    operations: payload.operations ?? [],
    ...(row.source === "RESOLUTION" && row.conflict_id ? { conflict_id: row.conflict_id } : {}),
  }).operations;
  return operations.map((operation): Operation =>
    operation.type === "rename"
      ? {
          type: "rename",
          from: operation.from,
          to: operation.to,
          ...(operation.content === undefined ? {} : { content: operation.content }),
          ...(operation.encoding === undefined ? {} : { encoding: operation.encoding }),
        }
      : operation,
  );
}

async function appliedPaths(ctx: CommandContext, row: ChangesetRow): Promise<string[]> {
  if (row.applied_revision === null) return [];
  const { rows } = await ctx.client.query<{ path: string }>(
    `SELECT path FROM file_revisions
     WHERE room_id = $1 AND workspace_id = $2 AND workspace_revision = $3
     ORDER BY path`,
    [ctx.room_id, row.workspace_id, row.applied_revision],
  );
  return rows.map(({ path }) => path);
}

async function readBlob(repoPath: string, commit: string, path: string) {
  const entry = (await entries(repoPath, commit, path)).find(
    (candidate) => candidate.path === path,
  );
  if (!entry) return { path, deleted: true as const };
  if (entry.type === "directory" || entry.type === "submodule")
    throw new CrossoverError("VALIDATION", `Invalid workspace path: ${path}`, {
      details: { path, reason: "not_a_file" },
    });
  validateFileSize(path, entry.size!);
  const { stdout } = await git(["cat-file", "blob", entry.oid], {
    gitDir: repoPath,
    timeoutMs: 10_000,
    encoding: "buffer",
  });
  const encoding =
    stdout.length > BINARY_SIZE || stdout.subarray(0, 8192).includes(0) || !isUtf8(stdout)
      ? "base64"
      : "utf8";
  return { path, content: stdout.toString(encoding), encoding };
}

/** Read ChangeSet metadata and, when requested, its candidate content under workspace.read. */
export function registerWorkspaceChangesetReads(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "workspace.changeset.get",
    action: "workspace.read",
    perPathAuthorize: true,
    mutating: false,
    view: "participant",
    view_probe: { changeset_id: "cs_view_probe" },
    params: changesetGetParamsSchema,
    execute: async (ctx, params) => {
      const { rows } = await ctx.client.query<ChangesetRow>(
        `SELECT cs.id, cs.workspace_id, w.repo_path, cs.actor_id, cs.source, cs.task_id,
                cs.conflict_id, cs.message, cs.base_workspace_revision, cs.applied_revision,
                cs.rejection_reason, cs.status, cs.base_file_revisions, cs.payload,
                cs.created_at, cs.applied_at
         FROM changesets cs JOIN workspaces w
           ON w.id = cs.workspace_id AND w.room_id = cs.room_id
         WHERE cs.room_id = $1 AND cs.id = $2`,
        [ctx.room_id, params.changeset_id],
      );
      const row = rows[0];
      if (!row) throw new CrossoverError("NOT_FOUND", "ChangeSet not found");

      const payload = record(row.payload);
      const breaker = record(payload.circuit_breaker);
      const operations = parseOperations(row);
      const paths =
        row.status === "APPLIED" ? await appliedPaths(ctx, row) : touchedPaths(operations);
      const visiblePaths = await readablePaths(ctx, paths);
      const holdReasons = Array.isArray(breaker.reasons)
        ? breaker.reasons.filter((reason): reason is string => typeof reason === "string")
        : [];
      const metadata = {
        id: row.id,
        status: row.status,
        source: row.source,
        actor_id: row.actor_id,
        message: row.message,
        base_workspace_revision: Number(row.base_workspace_revision),
        applied_revision: row.applied_revision === null ? null : Number(row.applied_revision),
        task_id: row.task_id,
        conflict_id: row.conflict_id,
        rejection_reason: row.rejection_reason,
        created_at: row.created_at.toISOString(),
        applied_at: iso(row.applied_at),
        paths: visiblePaths,
        hold_reasons: holdReasons,
      };
      if (params.path === undefined) return { response: metadata };

      if (!paths.includes(params.path) || !visiblePaths.includes(params.path))
        throw new CrossoverError("NOT_FOUND", "ChangeSet path not found");
      if (row.status !== "APPLIED") {
        const { rows: roomRows } = await ctx.client.query<{
          owner_id: string;
          lead_participant_id: string | null;
        }>("SELECT owner_id, lead_participant_id FROM rooms WHERE id = $1", [ctx.room_id]);
        const room = roomRows[0];
        const mayReadCandidate =
          row.actor_id === ctx.principal.participant_id ||
          ctx.principal.authority === "ADMIN" ||
          ctx.principal.authority === "OWNER" ||
          room?.owner_id === ctx.principal.participant_id ||
          room?.lead_participant_id === ctx.principal.participant_id;
        if (!mayReadCandidate)
          throw new CrossoverError(
            "FORBIDDEN",
            "Candidate content is restricted to the review ladder",
          );
      }

      if (row.status === "APPLIED") {
        const selected = await snapshot(ctx, Number(row.applied_revision));
        return {
          response: {
            ...metadata,
            ...(await readBlob(row.repo_path, selected.commit, params.path)),
          },
        };
      }
      const base = await snapshot(ctx, Number(row.base_workspace_revision));
      const candidate = await materialize(row.repo_path, base.commit, operations);
      return {
        response: { ...metadata, ...(await readBlob(row.repo_path, candidate, params.path)) },
      };
    },
  });
}
