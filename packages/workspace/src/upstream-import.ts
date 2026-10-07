import type { CommandContext, Dispatcher } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { z } from "zod";
import { git } from "./git.js";
import { normalizePath, PathValidationError } from "./path.js";
import { updateCanonicalRef } from "./reconcile.js";
import { refreshSearchTree } from "./search-tree.js";
import { treeChanges } from "./tree-changes.js";
import {
  assertPublicHttpsUrl,
  HttpsGitFetcher,
  MAX_UPSTREAM_URL_LENGTH,
  noCredentials,
  validBranch,
  type GitCredentialProvider,
  type UpstreamFetcher,
} from "./upstream.js";

/** The actor of every change that comes from upstream (§24.2). */
export const UPSTREAM_ACTOR = "system:upstream";

export const MAX_IMPORT_FILES = 20_000;
export const MAX_IMPORT_BYTES = 256 * 1024 * 1024;

export const gitImportParams = z.strictObject({
  /** An https repository URL, with no credentials in it. */
  url: z.string().min(1).max(MAX_UPSTREAM_URL_LENGTH),
  branch: z.string().min(1).max(200).refine(validBranch, "Not an allowed branch name"),
});

export interface UpstreamDeps {
  fetcher?: UpstreamFetcher;
  credentials?: GitCredentialProvider;
  /** Host check for the URL (tests); default: the DNS resolver. */
  resolve?: Parameters<typeof assertPublicHttpsUrl>[1];
}

export interface ImportHooks {
  updateCanonicalRef?: (repo: string, commit: string, expected: string) => Promise<void>;
  refreshSearchTree?: (repo: string, commit: string, previousCommit?: string) => Promise<void>;
  scheduleHealthCheck?: (roomId: string, revision: number) => void;
}

export const refuse = (reason: string, message: string, details: Record<string, unknown> = {}) =>
  new CrossoverError("VALIDATION", message, { details: { reason, ...details } });

interface TreeEntry {
  mode: string;
  type: string;
  size: number;
  path: string;
}

/** Every entry of `commit`'s tree, refusing what a workspace can't hold (§24.1). */
export async function listTree(repo: string, commit: string): Promise<TreeEntry[]> {
  const { stdout } = await git(["ls-tree", "-r", "-z", "-l", "--full-tree", commit], {
    gitDir: repo,
    timeoutMs: 60_000,
    maxBuffer: 512 * 1024 * 1024,
  });
  const entries: TreeEntry[] = [];
  let bytes = 0;
  for (const line of stdout.split("\0")) {
    if (line === "") continue;
    const match = /^(\d{6}) (\w+) [0-9a-f]+ +(-|\d+)\t([\s\S]+)$/.exec(line);
    if (!match) throw refuse("malformed_tree", "The upstream tree couldn't be read");
    const [, mode, type, size, rawPath] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (mode === "120000") {
      throw refuse("unsupported_entry", "The upstream contains a symbolic link", {
        path: rawPath,
        kind: "symlink",
      });
    }
    if (mode === "160000" || type === "commit") {
      throw refuse("unsupported_entry", "The upstream contains a submodule", {
        path: rawPath,
        kind: "submodule",
      });
    }
    let path: string;
    try {
      path = normalizePath(rawPath);
    } catch (error) {
      if (!(error instanceof PathValidationError)) throw error;
      throw refuse(
        "invalid_path",
        `The upstream has a path a workspace can't hold: ${error.message}`,
        {
          path: rawPath.slice(0, 200),
        },
      );
    }
    if (path !== rawPath) {
      throw refuse("invalid_path", "The upstream has a path that isn't in canonical form", {
        path: rawPath.slice(0, 200),
      });
    }
    bytes += Number(size);
    entries.push({ mode, type, size: Number(size), path });
    if (entries.length > MAX_IMPORT_FILES) {
      throw refuse("too_large", `The upstream has more than ${MAX_IMPORT_FILES} files`, {
        limit: MAX_IMPORT_FILES,
      });
    }
    if (bytes > MAX_IMPORT_BYTES) {
      throw refuse("too_large", "The upstream is larger than the import limit", {
        limit_bytes: MAX_IMPORT_BYTES,
      });
    }
  }
  return entries;
}

/**
 * Register `git.import { url, branch }` (T801, §24.1): fill an empty workspace from a Git
 * repository, as workspace revision 1.
 *
 * The room must have no revisions past 0 and no upstream (`VALIDATION` otherwise). The branch is
 * fetched through the {@link UpstreamFetcher} with whatever the {@link GitCredentialProvider}
 * gives (nothing for a public repository); the fetched objects are read into the room's
 * repository, so revision 1's tree *is* the upstream tip's tree, byte for byte. What a
 * workspace can't hold (symbolic links, submodules, paths that aren't safe) is refused with the
 * path named, and so is an upstream over the size limits. Then one transaction records the
 * ChangeSet (`source = UPSTREAM`, actor `system:upstream`, `APPLIED`), revision 1, a
 * file revision per file, and `upstreams { url, branch, last_synced_sha, last_synced_room_revision }`.
 * No credential reaches an event, a response, the database or an error.
 *
 * The fetch happens inside the command, so the room's lease is held while it runs; it is bounded
 * by the fetcher's timeout, and the room has no history yet.
 */
export function registerGitImport(
  dispatcher: Dispatcher,
  deps: UpstreamDeps = {},
  hooks: ImportHooks = {},
): void {
  const fetcher =
    deps.fetcher ?? new HttpsGitFetcher(deps.resolve ? { resolve: deps.resolve } : {});
  const credentials = deps.credentials ?? noCredentials;
  dispatcher.registerCommand({
    method: "git.import",
    mutating: true,
    params: gitImportParams,
    execute: async (ctx, p) => importUpstream(ctx, p, fetcher, credentials, deps, hooks),
  });
}

async function importUpstream(
  ctx: CommandContext,
  p: z.infer<typeof gitImportParams>,
  fetcher: UpstreamFetcher,
  credentials: GitCredentialProvider,
  deps: UpstreamDeps,
  hooks: ImportHooks,
) {
  const { client, room_id } = ctx;
  const { rows: workspaces } = await client.query<{ id: string; repo_path: string }>(
    "SELECT id, repo_path FROM workspaces WHERE room_id = $1 FOR UPDATE",
    [room_id],
  );
  const ws = workspaces[0];
  if (!ws) throw new CrossoverError("NOT_FOUND", "Workspace not provisioned");
  const { rows: heads } = await client.query<{ revision: string; commit_sha: string }>(
    `SELECT revision, commit_sha FROM workspace_revisions
     WHERE room_id = $1 AND workspace_id = $2 ORDER BY revision DESC LIMIT 1`,
    [room_id, ws.id],
  );
  const head = heads[0];
  if (!head) throw new CrossoverError("NOT_FOUND", "Workspace has no revision 0");
  if (Number(head.revision) !== 0) {
    throw refuse(
      "workspace_not_empty",
      "Only a workspace with no revisions beyond 0 can be imported into",
      { head_revision: Number(head.revision) },
    );
  }
  const { rowCount: already } = await client.query("SELECT 1 FROM upstreams WHERE room_id = $1", [
    room_id,
  ]);
  if (already) throw refuse("already_imported", "This room already has an upstream");

  const url = await assertPublicHttpsUrl(p.url, deps.resolve);
  const credential = await credentials.credentialFor(url);
  const fetched = await fetcher.fetch({ url: url.href, branch: p.branch, credential });
  try {
    const options = { gitDir: ws.repo_path, timeoutMs: 120_000 };
    // Read the fetched objects into the room's repository, under a ref of their own.
    await git(
      ["fetch", "--no-tags", "--quiet", fetched.repo, `+${fetched.ref}:refs/upstream/head`],
      options,
    );
    const sha = (
      await git(["rev-parse", "--verify", "refs/upstream/head^{commit}"], options)
    ).stdout.trim();
    if (sha !== fetched.sha)
      throw refuse("fetch_mismatch", "The fetched commit isn't the branch tip");
    const entries = await listTree(ws.repo_path, sha);
    const tree = (await git(["rev-parse", `${sha}^{tree}`], options)).stdout.trim();

    const message = `Import ${url.host}${url.pathname}@${p.branch} (${sha.slice(0, 12)})`;
    const commit = (
      await git(["commit-tree", tree, "-p", head.commit_sha], {
        ...options,
        input: message + "\n",
        env: {
          GIT_AUTHOR_NAME: "Crossover",
          GIT_AUTHOR_EMAIL: "system@crossover.local",
          GIT_COMMITTER_NAME: "Crossover",
          GIT_COMMITTER_EMAIL: "system@crossover.local",
        },
      })
    ).stdout.trim();
    const changed = await treeChanges(ws.repo_path, head.commit_sha, tree);

    const changesetId = newId("cs");
    await client.query(
      `INSERT INTO changesets (id, workspace_id, room_id, actor_id, idempotency_key, source,
         message, base_workspace_revision, base_file_revisions, payload)
       VALUES ($1, $2, $3, $4, $5, 'UPSTREAM', $6, 0, '{}'::jsonb, $7::jsonb)`,
      [
        changesetId,
        ws.id,
        room_id,
        UPSTREAM_ACTOR,
        ctx.idempotency_key,
        message,
        JSON.stringify({
          operations: [],
          import: { url: url.href, branch: p.branch, sha, files: entries.length },
        }),
      ],
    );
    await client.query(
      `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha, changeset_id)
       VALUES ($1, $2, 1, $3, $4)`,
      [ws.id, room_id, commit, changesetId],
    );
    for (const { path, blob } of changed) {
      await client.query(
        `INSERT INTO file_revisions (workspace_id, room_id, path, revision, workspace_revision, blob_sha, actor_id)
         VALUES ($1, $2, $3, 1, 1, $4, $5)`,
        [ws.id, room_id, path, blob, UPSTREAM_ACTOR],
      );
    }
    await client.query(
      `UPDATE changesets SET status = 'APPLIED', applied_revision = 1, applied_at = now()
       WHERE room_id = $1 AND id = $2`,
      [room_id, changesetId],
    );
    await client.query(
      `INSERT INTO upstreams (room_id, workspace_id, url, branch, last_synced_sha,
         last_synced_room_revision, imported_by)
       VALUES ($1, $2, $3, $4, $5, 1, $6)`,
      [room_id, ws.id, url.href, p.branch, sha, ctx.principal.participant_id],
    );

    ctx.afterCommit(async () => {
      await (hooks.updateCanonicalRef ?? updateCanonicalRef)(ws.repo_path, commit, head.commit_sha);
    });
    ctx.afterCommit(async () => {
      if (hooks.refreshSearchTree)
        await hooks.refreshSearchTree(ws.repo_path, commit, head.commit_sha);
      else await refreshSearchTree(ws.repo_path, commit, head.commit_sha);
    });
    if (hooks.scheduleHealthCheck) ctx.afterCommit(() => hooks.scheduleHealthCheck!(room_id, 1));

    const upstream = {
      url: url.href,
      branch: p.branch,
      last_synced_sha: sha,
      last_synced_room_revision: 1,
    };
    return {
      response: {
        upstream,
        changeset_id: changesetId,
        applied_revision: 1,
        file_count: entries.length,
      },
      events: [
        {
          type: "workspace.changeset.applied" as const,
          actor_id: UPSTREAM_ACTOR,
          payload: { changeset_id: changesetId, applied_revision: 1 },
        },
        {
          type: "workspace.upstream_synced" as const,
          payload: { ...upstream, imported: true, file_count: entries.length },
        },
      ],
    };
  } finally {
    await fetched.cleanup().catch(() => undefined);
  }
}
