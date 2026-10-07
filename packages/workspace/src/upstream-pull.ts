import type { CommandContext, CommandResult, Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import { apply, type ApplyResponse, type WorkspaceCommandDeps } from "./apply.js";
import { changesetParamsSchema } from "./changeset.js";
import { git } from "./git.js";
import { assertPublicHttpsUrl, HttpsGitFetcher, noCredentials } from "./upstream.js";
import { listTree, refuse, UPSTREAM_ACTOR } from "./upstream-import.js";

/** A ChangeSet carries at most this many operations (§10.1), so a pull of more is refused. */
const MAX_PULL_OPERATIONS = 500;

export const gitPullUpstreamParams = z.strictObject({});

interface UpstreamRow {
  url: string;
  branch: string;
  last_synced_sha: string;
  last_synced_room_revision: number;
}

interface RawChange {
  path: string;
  status: "A" | "M" | "D";
  blob: string | null;
  oldBlob: string | null;
}

/** Keep the commit the room last synced to reachable (and the next one while it is pending). */
export async function setUpstreamRef(repo: string, sha: string): Promise<void> {
  await git(["update-ref", "refs/upstream/head", sha], { gitDir: repo, timeoutMs: 10_000 });
}

/** The files that differ between two commits' trees, with what each was and became. */
async function rawChanges(repo: string, from: string, to: string): Promise<RawChange[]> {
  const { stdout } = await git(
    ["diff-tree", "--raw", "-r", "-z", "--no-renames", "--no-abbrev", "--no-ext-diff", from, to],
    { gitDir: repo, timeoutMs: 60_000, maxBuffer: 256 * 1024 * 1024 },
  );
  const fields = stdout.split("\0");
  const changes: RawChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDT])$/.exec(fields[i]!);
    const path = fields[i + 1];
    if (!match || !path) throw refuse("malformed_tree", "The upstream diff couldn't be read");
    const [, , , oldBlob, newBlob, status] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (status === "T") {
      throw refuse("unsupported_entry", "A file changed its type upstream", { path });
    }
    const gone = status === "D";
    changes.push({
      path,
      status: status as "A" | "M" | "D",
      blob: gone ? null : newBlob,
      oldBlob: status === "A" ? null : oldBlob,
    });
  }
  return changes;
}

/**
 * After a conflicting upstream pull is resolved (§24.2): the resolution applying is what applies
 * the pull, so `upstreams.last_synced_*` advance now, to the commit the pull carried. Returns the
 * new sync position, or null if the resolved ChangeSet wasn't an upstream pull.
 */
export async function advanceUpstreamAfterResolution(
  ctx: CommandContext,
  originalChangesetId: string,
  revision: number,
): Promise<(UpstreamRow & { changed_files: number }) | null> {
  const { rows } = await ctx.client.query<{ sha: string | null; files: number | null }>(
    `SELECT payload #>> '{upstream,sha}' AS sha, (payload #>> '{upstream,files}')::int AS files
     FROM changesets WHERE room_id = $1 AND id = $2 AND source = 'UPSTREAM'`,
    [ctx.room_id, originalChangesetId],
  );
  const sha = rows[0]?.sha;
  if (!sha) return null;
  const { rows: updated } = await ctx.client.query<UpstreamRow>(
    `UPDATE upstreams SET last_synced_sha = $2, last_synced_room_revision = $3
     WHERE room_id = $1 RETURNING url, branch, last_synced_sha, last_synced_room_revision`,
    [ctx.room_id, sha, revision],
  );
  return updated[0]
    ? {
        ...updated[0],
        last_synced_room_revision: Number(updated[0].last_synced_room_revision),
        changed_files: rows[0]?.files ?? 0,
      }
    : null;
}

export type PullResponse =
  { status: "UP_TO_DATE"; upstream: UpstreamRow } | (ApplyResponse & { upstream: UpstreamRow });

/**
 * Register `git.pull_upstream` (T803, §24.2): bring what changed upstream since the last sync
 * into the room as one ChangeSet.
 *
 * The branch is fetched like an import's, the diff `last_synced_sha → new tip` becomes
 * operations (creates, modifies, deletes; content is byte-exact), and the ChangeSet goes through
 * the normal apply pipeline (`source = UPSTREAM`, actor `system:upstream`, based on
 * `last_synced_room_revision`), so what the room changed in the meantime merges or conflicts like
 * any concurrent writer's change; a conflict's submitter of record is the caller (the lead or
 * owner). `upstreams.last_synced_*` advance only when the ChangeSet applies: at once if it
 * merges clean, or when its conflict is resolved. A second pull while an upstream conflict is
 * open is refused. An upstream that didn't change is `UP_TO_DATE`.
 *
 * Same limits as an import (no symlinks, submodules or unsafe paths), and at most 500 changed
 * files per pull.
 */
export function registerGitPullUpstream(dispatcher: Dispatcher, deps: WorkspaceCommandDeps): void {
  const fetcher =
    deps.upstream?.fetcher ??
    new HttpsGitFetcher(deps.upstream?.resolve ? { resolve: deps.upstream.resolve } : {});
  const credentials = deps.upstream?.credentials ?? noCredentials;
  dispatcher.registerCommand({
    method: "git.pull_upstream",
    perPathAuthorize: true,
    mutating: true,
    params: gitPullUpstreamParams,
    execute: async (ctx): Promise<CommandResult<PullResponse>> => {
      const { client, room_id } = ctx;
      const { rows: workspaces } = await client.query<{ id: string; repo_path: string }>(
        "SELECT id, repo_path FROM workspaces WHERE room_id = $1 FOR UPDATE",
        [room_id],
      );
      const ws = workspaces[0];
      if (!ws) throw new CrossoverError("NOT_FOUND", "Workspace not provisioned");
      const { rows: ups } = await client.query<UpstreamRow>(
        `SELECT url, branch, last_synced_sha, last_synced_room_revision
         FROM upstreams WHERE room_id = $1 FOR UPDATE`,
        [room_id],
      );
      const row = ups[0];
      const upstream = row && {
        ...row,
        last_synced_room_revision: Number(row.last_synced_room_revision), // bigint arrives as text
      };
      if (!upstream) throw refuse("no_upstream", "This room has no upstream to pull from");
      const { rowCount: open } = await client.query(
        `SELECT 1 FROM conflicts c JOIN changesets cs ON cs.id = c.changeset_id AND cs.room_id = c.room_id
         WHERE c.room_id = $1 AND cs.source = 'UPSTREAM' AND c.status IN ('OPEN', 'ESCALATED')`,
        [room_id],
      );
      if (open) {
        throw refuse(
          "upstream_conflict_open",
          "An earlier upstream pull is still in conflict; resolve it first",
        );
      }

      const url = await assertPublicHttpsUrl(upstream.url, deps.upstream?.resolve);
      const credential = await credentials.credentialFor(url);
      const fetched = await fetcher.fetch({ url: url.href, branch: upstream.branch, credential });
      try {
        const options = { gitDir: ws.repo_path, timeoutMs: 120_000 };
        await git(
          ["fetch", "--no-tags", "--quiet", fetched.repo, `+${fetched.ref}:refs/upstream/next`],
          options,
        );
        const sha = (
          await git(["rev-parse", "--verify", "refs/upstream/next^{commit}"], options)
        ).stdout.trim();
        if (sha !== fetched.sha)
          throw refuse("fetch_mismatch", "The fetched commit isn't the branch tip");
        if (sha === upstream.last_synced_sha) {
          return { response: { status: "UP_TO_DATE" as const, upstream } };
        }
        try {
          await git(["cat-file", "-e", `${upstream.last_synced_sha}^{commit}`], options);
        } catch {
          throw refuse("synced_commit_missing", "The last synced upstream commit is gone");
        }
        await listTree(ws.repo_path, sha); // refuses what a workspace can't hold
        const changes = await rawChanges(ws.repo_path, upstream.last_synced_sha, sha);
        const real = changes.filter((c) => c.blob !== c.oldBlob); // a mode-only change is no edit

        if (real.length === 0) {
          // The commit changed nothing a workspace holds: note it, change nothing else.
          await client.query("UPDATE upstreams SET last_synced_sha = $2 WHERE room_id = $1", [
            room_id,
            sha,
          ]);
          ctx.afterCommit(() => setUpstreamRef(ws.repo_path, sha));
          const synced = { ...upstream, last_synced_sha: sha };
          return {
            response: { status: "UP_TO_DATE" as const, upstream: synced },
            events: [
              {
                type: "workspace.upstream_synced" as const,
                payload: { ...synced, imported: false, changed_files: 0 },
              },
            ],
          };
        }
        if (real.length > MAX_PULL_OPERATIONS) {
          throw refuse(
            "too_many_changes",
            `The upstream changed more than ${MAX_PULL_OPERATIONS} files since the last sync`,
            { changed: real.length, limit: MAX_PULL_OPERATIONS },
          );
        }
        const operations = [];
        for (const change of real) {
          if (change.blob === null) {
            operations.push({ type: "delete" as const, path: change.path });
            continue;
          }
          const bytes = (
            await git(["cat-file", "blob", change.blob], {
              ...options,
              encoding: "buffer",
              maxBuffer: 64 * 1024 * 1024,
            })
          ).stdout;
          operations.push({
            type: change.status === "A" ? ("create" as const) : ("modify" as const),
            path: change.path,
            content: bytes.toString("base64"),
            encoding: "base64" as const,
          });
        }
        const params = changesetParamsSchema.parse({
          source: "UPSTREAM",
          message: `Pull ${url.host}${url.pathname}@${upstream.branch} (${sha.slice(0, 12)})`,
          base_workspace_revision: upstream.last_synced_room_revision,
          operations,
        });
        const out = await apply(ctx, params, deps, {
          actorId: UPSTREAM_ACTOR,
          payload: { upstream: { sha, files: real.length } },
        });
        if (out.response.status !== "APPLIED") {
          return { ...out, response: { ...out.response, upstream } };
        }
        const synced = {
          ...upstream,
          last_synced_sha: sha,
          last_synced_room_revision: out.response.applied_revision,
        };
        await client.query(
          `UPDATE upstreams SET last_synced_sha = $2, last_synced_room_revision = $3
           WHERE room_id = $1`,
          [room_id, sha, synced.last_synced_room_revision],
        );
        ctx.afterCommit(() => setUpstreamRef(ws.repo_path, sha));
        return {
          response: { ...out.response, upstream: synced },
          events: [
            ...(out.events ?? []),
            {
              type: "workspace.upstream_synced" as const,
              payload: { ...synced, imported: false, changed_files: real.length },
            },
          ],
        };
      } finally {
        await fetched.cleanup().catch(() => undefined);
      }
    },
  });
}
