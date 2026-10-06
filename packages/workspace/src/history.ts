import type { Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import { git, GitError } from "./git.js";
import { pathSchema, snapshot } from "./reads.js";

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const workspaceDiffParamsSchema = z.strictObject({
  from_revision: revision,
  to_revision: revision,
  paths: z.array(pathSchema()).max(500).optional(),
});
const workspaceHistoryParamsSchema = z.strictObject({
  path: pathSchema().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  before: revision.optional(),
});
const DIFF_LIMIT = 5 * 1024 * 1024;
function tooLarge(): never {
  throw new CrossoverError("VALIDATION", "Workspace diff too large; narrow paths", {
    details: { reason: "diff_too_large", limit: DIFF_LIMIT },
  });
}

/** Strip engine metadata, preserving user text (even text resembling Git headers). */
function publicDiff(patch: string): string {
  let header = true;
  let submodule = false;
  return patch
    .split("\n")
    .flatMap((line) => {
      if (line.startsWith("diff --git ")) {
        header = true;
        submodule = false;
      }
      if (header && /^(?:index .*|(?:new file|deleted file|old|new) mode) 160000$/.test(line))
        submodule = true;
      if (line.startsWith("@@ ")) header = false;
      if (header && line.startsWith("index ")) return [];
      // Submodules are opaque entries; their internal object identities are not public.
      if (submodule && /^[+-]Subproject commit [0-9a-f]+/.test(line))
        return [`${line[0]}Submodule content changed`];
      return [line];
    })
    .join("\n");
}

/** Diff and paginate committed revision metadata (§9.1, §9.6), without consulting refs. */
export function registerWorkspaceHistory(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "workspace.diff",
    action: "workspace.read",
    perPathAuthorize: true,
    mutating: false,
    params: workspaceDiffParamsSchema,
    execute: async (ctx, params) => {
      if (params.from_revision > params.to_revision)
        throw new CrossoverError("VALIDATION", "Revision range is reversed");
      const from = await snapshot(ctx, params.from_revision);
      const to = await snapshot(ctx, params.to_revision);
      const paths = params.paths?.length
        ? params.paths
        : (
            await git(["diff", "--name-only", "-z", "--no-renames", from.commit, to.commit], {
              gitDir: from.repo_path,
              timeoutMs: 10_000,
            })
          ).stdout
            .split("\0")
            .filter(Boolean);
      if (params.paths?.length) {
        for (const path of paths) await ctx.authorize("workspace.read", { path });
      } else {
        const visible: string[] = [];
        for (const path of paths) {
          try {
            await ctx.authorize("workspace.read", { path });
            visible.push(path);
          } catch (error) {
            if (!(error instanceof CrossoverError) || error.code !== "FORBIDDEN") throw error;
          }
        }
        paths.splice(0, paths.length, ...visible);
      }
      if (paths.length === 0)
        return { response: { from_revision: from.revision, to_revision: to.revision, diff: "" } };
      let patch: string;
      try {
        patch = (
          await git(
            [
              "-c",
              "core.bigFileThreshold=5m",
              "diff",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--no-renames",
              "--submodule=short",
              from.commit,
              to.commit,
              "--",
              ...paths,
            ],
            {
              gitDir: from.repo_path,
              timeoutMs: 10_000,
              maxBuffer: DIFF_LIMIT + 1024 * 1024,
              env: { GIT_LITERAL_PATHSPECS: "1" },
            },
          )
        ).stdout;
      } catch (error) {
        if (
          error instanceof GitError &&
          (error.cause as NodeJS.ErrnoException)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        )
          tooLarge();
        throw error;
      }
      const diff = publicDiff(patch);
      if (Buffer.byteLength(diff) > DIFF_LIMIT) tooLarge();
      return { response: { from_revision: from.revision, to_revision: to.revision, diff } };
    },
  });
  dispatcher.registerCommand({
    method: "workspace.history",
    action: "workspace.read",
    perPathAuthorize: true,
    mutating: false,
    params: workspaceHistoryParamsSchema,
    execute: async (ctx, params) => {
      if (params.path !== undefined) await ctx.authorize("workspace.read", { path: params.path });
      const ws = await snapshot(ctx);
      type HistoryRow = {
        workspace_revision: string;
        changeset_id: string | null;
        actor_id: string | null;
        message: string | null;
        created_at: Date;
        file_revision: string | null;
        deleted: boolean | null;
        file_path: string | null;
      };
      const visibleRows: HistoryRow[] = [];
      const authorization = new Map<string, boolean>();
      let before: number | string | null = params.before ?? null;
      let exhausted = false;
      while (visibleRows.length <= params.limit && !exhausted) {
        const pageResult = await ctx.client.query<HistoryRow>(
          `WITH page AS (
             SELECT wr.workspace_id, wr.room_id, wr.revision, wr.changeset_id, wr.created_at
             FROM workspace_revisions wr
             WHERE wr.room_id = $1 AND wr.workspace_id = $2 AND wr.revision <= $5
               AND ($3::text IS NULL OR EXISTS (
                 SELECT 1 FROM file_revisions path_fr
                 WHERE path_fr.room_id = wr.room_id AND path_fr.workspace_id = wr.workspace_id
                   AND path_fr.workspace_revision = wr.revision AND path_fr.path = $3
               ))
               AND ($4::bigint IS NULL OR wr.revision < $4)
             ORDER BY wr.revision DESC LIMIT $6
           )
           SELECT wr.revision AS workspace_revision, wr.changeset_id, cs.actor_id, cs.message,
             wr.created_at, fr.revision AS file_revision, fr.blob_sha IS NULL AS deleted,
             fr.path AS file_path
           FROM page wr
           LEFT JOIN changesets cs ON cs.id = wr.changeset_id AND cs.room_id = wr.room_id
             AND cs.workspace_id = wr.workspace_id
           LEFT JOIN file_revisions fr ON fr.workspace_id = wr.workspace_id AND fr.room_id = wr.room_id
             AND fr.workspace_revision = wr.revision AND ($3::text IS NULL OR fr.path = $3)
           ORDER BY wr.revision DESC`,
          [ctx.room_id, ws.id, params.path ?? null, before, ws.revision, 100],
        );
        const rows: HistoryRow[] = pageResult.rows;
        if (rows.length === 0) break;
        const byRevision = new Map<string, HistoryRow[]>();
        for (const row of rows) {
          const items = byRevision.get(row.workspace_revision) ?? [];
          items.push(row);
          byRevision.set(row.workspace_revision, items);
        }
        for (const revisionRows of byRevision.values()) {
          const row = revisionRows[0]!;
          if (params.path === undefined && revisionRows.some((item) => item.file_path !== null)) {
            let readable = true;
            for (const path of new Set(revisionRows.flatMap((item) => item.file_path ?? []))) {
              let allowed = authorization.get(path);
              if (allowed === undefined) {
                try {
                  await ctx.authorize("workspace.read", { path });
                  allowed = true;
                } catch (error) {
                  if (!(error instanceof CrossoverError) || error.code !== "FORBIDDEN") throw error;
                  allowed = false;
                }
                authorization.set(path, allowed);
              }
              if (!allowed) {
                readable = false;
                break;
              }
            }
            if (!readable) continue;
          }
          visibleRows.push(row);
          if (visibleRows.length > params.limit) break;
        }
        before = rows.at(-1)!.workspace_revision;
        if (rows.length < 100 || visibleRows.length > params.limit) exhausted = true;
      }
      const entries = visibleRows.slice(0, params.limit).map((row) => ({
        workspace_revision: Number(row.workspace_revision),
        changeset_id: row.changeset_id,
        actor_id: row.actor_id,
        message: row.message,
        created_at: row.created_at.toISOString(),
        ...(params.path === undefined
          ? {}
          : {
              file_revision: Number(row.file_revision),
              ...(row.deleted ? { deleted: true } : {}),
            }),
      }));
      return {
        response: {
          entries,
          next_before:
            visibleRows.length > params.limit ? entries.at(-1)!.workspace_revision : null,
        },
      };
    },
  });
}
