import { isUtf8 } from "node:buffer";
import type { CommandContext, Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import { BINARY_SIZE, validateFileSize } from "./binary.js";
import { git } from "./git.js";
import { normalizePath, PathValidationError } from "./path.js";

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();
export function pathSchema(root = false) {
  return z.string().transform((value, ctx) => {
    if (root && ["", ".", "./"].includes(value)) return "";
    try {
      return normalizePath(value);
    } catch (error) {
      if (!(error instanceof PathValidationError)) throw error;
      ctx.addIssue({ code: "custom", message: error.message });
      return z.NEVER;
    }
  });
}
type Entry = {
  path: string;
  oid: string;
  type: "file" | "directory" | "symlink" | "submodule";
  size?: number;
};
async function entries(repo: string, tree: string, path?: string): Promise<Entry[]> {
  const { stdout } = await git(
    ["ls-tree", "-l", "-z", "--full-tree", tree, ...(path === undefined ? [] : ["--", path])],
    {
      gitDir: repo,
      timeoutMs: 10_000,
      env: { GIT_LITERAL_PATHSPECS: "1" },
    },
  );
  return stdout
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const [mode, type, oid, size] = record.slice(0, tab).trim().split(/\s+/);
      return {
        path: record.slice(tab + 1),
        oid: oid!,
        ...(type === "blob" ? { size: Number(size) } : {}),
        type:
          mode === "160000"
            ? "submodule"
            : mode === "120000"
              ? "symlink"
              : type === "tree"
                ? "directory"
                : "file",
      };
    });
}
export async function snapshot(ctx: CommandContext, selected?: number) {
  const ws = (
    await ctx.client.query<{ id: string; repo_path: string }>(
      "SELECT id, repo_path FROM workspaces WHERE room_id = $1",
      [ctx.room_id],
    )
  ).rows[0];
  if (!ws) throw new CrossoverError("NOT_FOUND", "Workspace not provisioned");
  const head = (
    await ctx.client.query<{ revision: string; commit_sha: string }>(
      `SELECT revision, commit_sha FROM workspace_revisions WHERE room_id = $1 AND workspace_id = $2
     AND ($3::bigint IS NULL OR revision = $3) ORDER BY revision DESC LIMIT 1`,
      [ctx.room_id, ws.id, selected ?? null],
    )
  ).rows[0];
  if (!head) throw new CrossoverError("NOT_FOUND", "Workspace revision not found");
  return { ...ws, commit: head.commit_sha, revision: Number(head.revision) };
}
async function fileRevisions(
  ctx: CommandContext,
  workspace: string,
  revision: number,
  paths: string[],
) {
  const { rows } = await ctx.client.query<{ path: string; revision: string }>(
    `SELECT DISTINCT ON (path) path, revision FROM file_revisions
     WHERE room_id = $1 AND workspace_id = $2 AND workspace_revision <= $3 AND path = ANY($4::text[])
     ORDER BY path, workspace_revision DESC, revision DESC`,
    [ctx.room_id, workspace, revision, paths],
  );
  return new Map(rows.map((row) => [row.path, Number(row.revision)]));
}
function notFile(path: string, reason: string): never {
  throw new CrossoverError("VALIDATION", `Invalid workspace path: ${path}`, {
    details: { path, reason },
  });
}

/** Read committed snapshots (§9.1); cached refs, worktrees and symlink targets are never followed. */
export function registerWorkspaceReads(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "workspace.read",
    action: "workspace.read",
    mutating: false,
    params: z.strictObject({ path: pathSchema(), revision }),
    execute: async (ctx, params) => {
      await ctx.authorize("workspace.read", { path: params.path });
      const ws = await snapshot(ctx, params.revision);
      const entry = (await entries(ws.repo_path, ws.commit, params.path)).find(
        (entry) => entry.path === params.path,
      );
      if (!entry) throw new CrossoverError("NOT_FOUND", "Workspace path not found");
      if (entry.type === "directory" || entry.type === "submodule")
        notFile(params.path, "not_a_file");
      validateFileSize(params.path, entry.size!);
      const { stdout } = await git(["cat-file", "blob", entry.oid], {
        gitDir: ws.repo_path,
        timeoutMs: 10_000,
        encoding: "buffer",
      });
      const encoding =
        stdout.length > BINARY_SIZE || stdout.subarray(0, 8192).includes(0) || !isUtf8(stdout)
          ? "base64"
          : "utf8";
      const revisions = await fileRevisions(ctx, ws.id, ws.revision, [params.path]);
      return {
        response: {
          content: stdout.toString(encoding),
          encoding,
          file_revision: revisions.get(params.path) ?? 0,
          workspace_revision: ws.revision,
        },
      };
    },
  });
  dispatcher.registerCommand({
    method: "workspace.list",
    action: "workspace.read",
    mutating: false,
    params: z.strictObject({ path: pathSchema(true).default(""), revision }),
    execute: async (ctx, params) => {
      await ctx.authorize("workspace.read", { path: params.path });
      const ws = await snapshot(ctx, params.revision);
      let tree = ws.commit;
      if (params.path) {
        const target = (await entries(ws.repo_path, ws.commit, params.path)).find(
          (entry) => entry.path === params.path,
        );
        if (!target) throw new CrossoverError("NOT_FOUND", "Workspace path not found");
        if (target.type !== "directory") notFile(params.path, "not_a_directory");
        tree = target.oid;
      }
      const children = (await entries(ws.repo_path, tree)).map((entry) => ({
        ...entry,
        path: params.path ? `${params.path}/${entry.path}` : entry.path,
      }));
      const revisions = await fileRevisions(
        ctx,
        ws.id,
        ws.revision,
        children
          .filter((entry) => entry.type === "file" || entry.type === "symlink")
          .map((entry) => entry.path),
      );
      return {
        response: {
          workspace_revision: ws.revision,
          entries: children
            .map((entry) => ({
              path: entry.path,
              type: entry.type,
              ...(entry.size === undefined ? {} : { size: entry.size }),
              ...(entry.type === "file" || entry.type === "symlink"
                ? { file_revision: revisions.get(entry.path) ?? 0 }
                : {}),
            }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        },
      };
    },
  });
}
