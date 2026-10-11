import type { Pool, PoolClient } from "@crossover/db";
import type { CommandContext, CommandResult, Dispatcher, EmittedEvent } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import { apply, type ApplyResponse, type WorkspaceCommandDeps } from "./apply.js";
import { changesetParamsSchema } from "./changeset.js";
import { git } from "./git.js";
import type { Operation } from "./operations.js";
import { HttpsGitFetcher, noCredentials } from "./upstream.js";
import {
  disposeFetched,
  fetchIntoRoomRepo,
  listTree,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_FILES,
  refuse,
  UPSTREAM_ACTOR,
  type PreparedFetch,
} from "./upstream-import.js";

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
  const { rows } = await ctx.client.query<{
    sha: string | null;
    files: number | null;
    part: number | null;
    parts: number | null;
  }>(
    `SELECT payload #>> '{upstream,sha}' AS sha, (payload #>> '{upstream,files}')::int AS files,
            (payload #>> '{upstream,part}')::int AS part, (payload #>> '{upstream,parts}')::int AS parts
     FROM changesets WHERE room_id = $1 AND id = $2 AND source = 'UPSTREAM'`,
    [ctx.room_id, originalChangesetId],
  );
  const sha = rows[0]?.sha;
  if (!sha) return null;
  // A big pull is applied in parts. Resolving a conflict in one of the early parts doesn't finish
  // the pull: the position stays, and the next pull carries on (what is already in is skipped).
  if (rows[0]?.parts != null && rows[0].part !== rows[0].parts) return null;
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
  | { status: "UP_TO_DATE"; upstream: UpstreamRow }
  | (Extract<ApplyResponse, { status: "APPLIED" }> & { upstream: UpstreamRow })
  | (Extract<ApplyResponse, { status: "HELD" }> & {
      upstream: UpstreamRow;
      parts: number;
      applied_parts: number;
    })
  | (Extract<ApplyResponse, { status: "CONFLICT" }> & {
      upstream: UpstreamRow;
      /** How many ChangeSets the pull was split into, and how many of them applied before this one conflicted. */
      parts: number;
      applied_parts: number;
    });

/** What each file is at `commit`: its blob id, or null if it isn't there. */
async function blobsAt(
  repo: string,
  commit: string,
  paths: string[],
): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  if (paths.length === 0) return found;
  const { stdout } = await git(["cat-file", "--batch-check"], {
    gitDir: repo,
    timeoutMs: 60_000,
    maxBuffer: 256 * 1024 * 1024,
    input: paths.map((path) => `${commit}:${path}\n`).join(""),
  });
  const lines = stdout.split("\n");
  paths.forEach((path, i) => {
    const match = /^([0-9a-f]{40,64}) blob /.exec(lines[i] ?? "");
    found.set(path, match ? match[1]! : null);
  });
  return found;
}

/** The content of each blob, in order, in one Git process. */
async function readBlobs(repo: string, shas: string[]): Promise<Buffer[]> {
  if (shas.length === 0) return [];
  const { stdout } = await git(["cat-file", "--batch"], {
    gitDir: repo,
    encoding: "buffer",
    timeoutMs: 120_000,
    maxBuffer: 1024 * 1024 * 1024,
    input: shas.map((sha) => `${sha}\n`).join(""),
  });
  const blobs: Buffer[] = [];
  let at = 0;
  for (const sha of shas) {
    const eol = stdout.indexOf(0x0a, at);
    const match = /^[0-9a-f]{40,64} blob (\d+)$/.exec(stdout.subarray(at, eol).toString("utf8"));
    if (eol < 0 || !match)
      throw refuse("malformed_tree", "A file of the upstream couldn't be read", { sha });
    const size = Number(match[1]);
    blobs.push(stdout.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  return blobs;
}

/** Most files, and most bytes of new content, one pull applies (the import's limits by default). */
async function assertPullSize(
  repo: string,
  changes: RawChange[],
  limits: { files?: number; bytes?: number } = {},
): Promise<void> {
  const maxFiles = limits.files ?? MAX_IMPORT_FILES;
  const maxBytes = limits.bytes ?? MAX_IMPORT_BYTES;
  if (changes.length > maxFiles) {
    throw refuse(
      "too_many_changes",
      `The upstream changed more than ${maxFiles} files since the last sync`,
      {
        changed: changes.length,
        limit_files: maxFiles,
      },
    );
  }
  const blobs = changes.flatMap((c) => (c.blob === null ? [] : [c.blob]));
  if (blobs.length === 0) return;
  const { stdout } = await git(["cat-file", "--batch-check"], {
    gitDir: repo,
    timeoutMs: 60_000,
    maxBuffer: 256 * 1024 * 1024,
    input: blobs.map((sha) => `${sha}\n`).join(""),
  });
  let bytes = 0;
  for (const line of stdout.split("\n")) bytes += Number(/ blob (\d+)$/.exec(line)?.[1] ?? 0);
  if (bytes > maxBytes) {
    throw refuse(
      "too_many_changes",
      "The upstream's new content since the last sync is too large to pull",
      {
        bytes,
        limit_bytes: maxBytes,
      },
    );
  }
}

/** A ChangeSet holds at most this many operations (§10.1) and a bit under 25 MiB of text. */
const MAX_PULL_OPERATIONS = 500;
const MAX_CHUNK_BYTES = 20 * 1024 * 1024;

interface PreparedPull extends PreparedFetch {
  /** What the room's upstream was when the fetch started; `execute` checks it still is. */
  assumed: { url: string; branch: string; last_synced_sha: string };
  /** Files that differ between the last synced commit and the new tip. */
  changes: RawChange[];
}

/**
 * Register `git.pull_upstream` (T803, T807, §24.2): bring what changed upstream since the last
 * sync into the room as ChangeSets.
 *
 * The fetch is the command's `prepare`, so it runs before the transaction without holding the
 * room: other commands carry on meanwhile. `execute` then locks the room and checks that nothing
 * `prepare` assumed has moved (the upstream's URL, branch and last synced commit, no open
 * conflict from an earlier pull), and refuses with `CONFLICT_VERSION` if it has.
 *
 * The diff `last_synced_sha → new tip` becomes operations (creates, modifies, deletes; content is
 * byte-exact), minus files the room already has with the new content. They are applied through
 * the normal apply pipeline as `source = UPSTREAM`, actor `system:upstream`, based on
 * `last_synced_room_revision`, so what the room changed in the meantime merges or conflicts like
 * any concurrent writer's change; a conflict's submitter of record is the caller. A pull of more
 * than 500 files (or ~20 MiB) is split into ordered ChangeSets, each based on the same
 * revision; the first to conflict stops the pull there. `upstreams.last_synced_*` advance only
 * when the whole pull has applied: at once if it merges clean, or when the conflict in its last
 * part is resolved (after an earlier part's conflict is resolved, pull again to continue). A
 * second pull while an upstream conflict is open is refused. An upstream that didn't change is
 * `UP_TO_DATE`.
 *
 * Same limits as an import: no symlinks, submodules or unsafe paths.
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
    prepare: async (ctx): Promise<PreparedPull> => {
      const { rows: workspaces } = await ctx.pool.query<{ repo_path: string }>(
        "SELECT repo_path FROM workspaces WHERE room_id = $1",
        [ctx.room_id],
      );
      const ws = workspaces[0];
      if (!ws) throw new CrossoverError("NOT_FOUND", "Workspace not provisioned");
      const upstream = await readUpstream(ctx.pool, ctx.room_id);
      if (!upstream) throw refuse("no_upstream", "This room has no upstream to pull from");
      await assertNoOpenUpstreamConflict(ctx.pool, ctx.room_id, refuse);
      const fetchedInto = await fetchIntoRoomRepo(
        ctx,
        ws.repo_path,
        { url: upstream.url, branch: upstream.branch },
        fetcher,
        credentials,
        deps.upstream ?? {},
      );
      try {
        const options = { gitDir: ws.repo_path, timeoutMs: 120_000 };
        let changes: RawChange[] = [];
        if (fetchedInto.sha !== upstream.last_synced_sha) {
          try {
            await git(["cat-file", "-e", `${upstream.last_synced_sha}^{commit}`], options);
          } catch {
            throw refuse("synced_commit_missing", "The last synced upstream commit is gone");
          }
          await listTree(ws.repo_path, fetchedInto.sha); // refuses what a workspace can't hold
          changes = (
            await rawChanges(ws.repo_path, upstream.last_synced_sha, fetchedInto.sha)
          ).filter((c) => c.blob !== c.oldBlob); // a mode-only change is no edit
          await assertPullSize(ws.repo_path, changes, deps.upstream?.pullLimits);
        }
        return {
          ...fetchedInto,
          assumed: {
            url: upstream.url,
            branch: upstream.branch,
            last_synced_sha: upstream.last_synced_sha,
          },
          changes,
        };
      } catch (error) {
        await disposeFetched(fetchedInto);
        throw error;
      }
    },
    disposePrepared: async (prepared) => disposeFetched(prepared as PreparedPull),
    execute: async (ctx): Promise<CommandResult<PullResponse>> => {
      const prepared = ctx.prepared as PreparedPull | undefined;
      if (!prepared) throw new Error("git.pull_upstream ran without its prepared fetch");
      const { client, room_id } = ctx;
      const { rows: workspaces } = await client.query<{ id: string; repo_path: string }>(
        "SELECT id, repo_path FROM workspaces WHERE room_id = $1 FOR UPDATE",
        [room_id],
      );
      const ws = workspaces[0];
      if (!ws) throw new CrossoverError("NOT_FOUND", "Workspace not provisioned");
      const upstream = await readUpstream(client, room_id, true);
      const moved = (reason: string) =>
        new CrossoverError(
          "CONFLICT_VERSION",
          "The upstream changed while it was being fetched; pull again",
          {
            details: { reason },
          },
        );
      if (
        !upstream ||
        upstream.url !== prepared.assumed.url ||
        upstream.branch !== prepared.assumed.branch ||
        upstream.last_synced_sha !== prepared.assumed.last_synced_sha
      ) {
        throw moved("upstream_moved");
      }
      await assertNoOpenUpstreamConflict(client, room_id, () => moved("upstream_conflict_opened"));

      const sha = prepared.sha;
      const url = prepared.url;
      const heads = await client.query<{ commit_sha: string }>(
        `SELECT commit_sha FROM workspace_revisions
         WHERE room_id = $1 AND workspace_id = $2 ORDER BY revision DESC LIMIT 1`,
        [room_id, ws.id],
      );
      const head = heads.rows[0]!.commit_sha;
      // Files the room already has with the new content (an earlier part of this pull, say) need no operation.
      const atHead = await blobsAt(
        ws.repo_path,
        head,
        prepared.changes.map((c) => c.path),
      );
      // …nor files whose conflict in an earlier, partly-applied pull of this same commit was resolved.
      const resolved = await resolvedPaths(client, room_id, sha);
      const real = prepared.changes.filter(
        (c) => (atHead.get(c.path) ?? null) !== c.blob && !resolved.has(c.path),
      );

      if (real.length === 0) {
        // Nothing a workspace holds differs: note the new commit, change nothing else.
        if (sha !== upstream.last_synced_sha) {
          await client.query("UPDATE upstreams SET last_synced_sha = $2 WHERE room_id = $1", [
            room_id,
            sha,
          ]);
          ctx.afterCommit(() => setUpstreamRef(ws.repo_path, sha));
        }
        const synced = { ...upstream, last_synced_sha: sha };
        return {
          response: { status: "UP_TO_DATE" as const, upstream: synced },
          ...(sha === upstream.last_synced_sha
            ? {}
            : {
                events: [
                  {
                    type: "workspace.upstream_synced" as const,
                    payload: { ...synced, imported: false, changed_files: 0 },
                  },
                ],
              }),
        };
      }

      // Operations, in chunks a ChangeSet can hold.
      const chunks: Operation[][] = [[]];
      let bytes = 0;
      const contents = await readBlobs(
        ws.repo_path,
        real.flatMap((c) => (c.blob === null ? [] : [c.blob])),
      );
      let next = 0;
      for (const change of real) {
        let op: Operation;
        let size = 0;
        if (change.blob === null) {
          op = { type: "delete", path: change.path };
        } else {
          const content = contents[next++]!;
          size = content.length;
          op = {
            // Relative to the base the ChangeSet is merged from (the last sync), not to the head:
            // a file the room also added is an add/add the merge reports as a conflict.
            type: change.status === "A" ? "create" : "modify",
            path: change.path,
            content: content.toString("base64"),
            encoding: "base64",
          } as Operation;
        }
        let current = chunks[chunks.length - 1]!;
        if (
          current.length >= MAX_PULL_OPERATIONS ||
          (current.length > 0 && bytes + size > MAX_CHUNK_BYTES)
        ) {
          current = [];
          chunks.push(current);
          bytes = 0;
        }
        current.push(op);
        bytes += size;
      }

      const events: EmittedEvent[] = [];
      let last: ApplyResponse | undefined;
      for (const [i, operations] of chunks.entries()) {
        const parts = chunks.length;
        const params = changesetParamsSchema.parse({
          source: "UPSTREAM",
          message: `Pull ${url.host}${url.pathname}@${upstream.branch} (${sha.slice(0, 12)})${parts > 1 ? ` part ${i + 1}/${parts}` : ""}`,
          base_workspace_revision: upstream.last_synced_room_revision,
          operations,
        });
        const out = await apply(
          {
            ...ctx,
            idempotency_key: parts > 1 ? `${ctx.idempotency_key}#${i + 1}` : ctx.idempotency_key,
          },
          params,
          deps,
          {
            actorId: UPSTREAM_ACTOR,
            payload: { upstream: { sha, files: real.length, part: i + 1, parts } },
          },
        );
        events.push(...(out.events ?? []));
        last = out.response;
        if (out.response.status !== "APPLIED") {
          return {
            response: { ...out.response, upstream, parts, applied_parts: i },
            events,
            ...(out.committedError ? { committedError: out.committedError } : {}),
          };
        }
      }
      const applied = last as Extract<ApplyResponse, { status: "APPLIED" }>;
      const synced = {
        ...upstream,
        last_synced_sha: sha,
        last_synced_room_revision: applied.applied_revision,
      };
      await client.query(
        `UPDATE upstreams SET last_synced_sha = $2, last_synced_room_revision = $3
         WHERE room_id = $1`,
        [room_id, sha, synced.last_synced_room_revision],
      );
      ctx.afterCommit(() => setUpstreamRef(ws.repo_path, sha));
      return {
        response: { ...applied, upstream: synced },
        events: [
          ...events,
          {
            type: "workspace.upstream_synced" as const,
            payload: { ...synced, imported: false, changed_files: real.length },
          },
        ],
      };
    },
  });
}

/** Paths whose conflict in an earlier pull of commit `sha` has been resolved by someone. */
async function resolvedPaths(
  db: Pool | PoolClient,
  room_id: string,
  sha: string,
): Promise<Set<string>> {
  const { rows } = await db.query<{
    files: { path?: string | null; messages?: { paths?: string[] }[] }[];
  }>(
    `SELECT c.files FROM conflicts c JOIN changesets cs ON cs.id = c.changeset_id AND cs.room_id = c.room_id
     WHERE c.room_id = $1 AND c.status = 'RESOLVED' AND cs.source = 'UPSTREAM'
       AND cs.payload #>> '{upstream,sha}' = $2`,
    [room_id, sha],
  );
  const paths = new Set<string>();
  for (const { files } of rows) {
    for (const file of files ?? []) {
      if (typeof file.path === "string") paths.add(file.path);
      for (const message of file.messages ?? [])
        for (const path of message.paths ?? []) paths.add(path);
    }
  }
  return paths;
}

async function readUpstream(
  db: Pool | PoolClient,
  room_id: string,
  lock = false,
): Promise<UpstreamRow | undefined> {
  const { rows } = await db.query<UpstreamRow>(
    `SELECT url, branch, last_synced_sha, last_synced_room_revision
     FROM upstreams WHERE room_id = $1${lock ? " FOR UPDATE" : ""}`,
    [room_id],
  );
  const row = rows[0];
  return (
    row && {
      ...row,
      last_synced_room_revision: Number(row.last_synced_room_revision), // bigint arrives as text
    }
  );
}

async function assertNoOpenUpstreamConflict(
  db: Pool | PoolClient,
  room_id: string,
  fail: (reason: string, message: string) => Error,
): Promise<void> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM conflicts c JOIN changesets cs ON cs.id = c.changeset_id AND cs.room_id = c.room_id
     WHERE c.room_id = $1 AND cs.source = 'UPSTREAM' AND c.status IN ('OPEN', 'ESCALATED')`,
    [room_id],
  );
  if (rowCount) {
    throw fail(
      "upstream_conflict_open",
      "An earlier upstream pull is still in conflict; resolve it first",
    );
  }
}
