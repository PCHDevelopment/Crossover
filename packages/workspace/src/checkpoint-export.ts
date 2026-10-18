import type { Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import { git } from "./git.js";
import {
  assertPublicHttpsUrl,
  githubRepositoryFromUrl,
  HttpsGitPusher,
  noCredentials,
  scrub,
  validBranch,
} from "./upstream.js";
import { UPSTREAM_ACTOR, type UpstreamDeps } from "./upstream-import.js";

export const DEFAULT_PLATFORM_DOMAIN = "crossover.local";
const MAX_LISTED_COMMITS = 200;

export const checkpointsExportParams = z.strictObject({
  /** Default: the room's latest checkpoint. */
  checkpoint_id: z.string().min(1).max(100).optional(),
  /** `squashed`: one commit per checkpoint. `per_changeset`: one per applied ChangeSet. */
  mode: z.enum(["squashed", "per_changeset"]).default("squashed"),
  /** Default `room/<room-slug>`. Only `room/*` branches are ever pushed to. */
  branch: z.string().min(1).max(200).optional(),
  /**
   * Also open a pull request from the branch into the upstream's own branch. Needs the
   * `github.create_pull_request` capability (Tier 2) for the repository.
   */
  pull_request: z
    .strictObject({
      title: z.string().trim().min(1).max(200).optional(),
      body: z.string().max(4000).optional(),
    })
    .optional(),
});

interface Contributor {
  id: string;
  kind: string;
  display_name: string;
}

/** A line a Git trailer parser would take for a trailer (`Token: value`). */
const TRAILER_LINE = /^\s*[A-Za-z0-9][A-Za-z0-9-]*\s*:/;

/** Put a visible marker in front of any trailer-shaped line of user text. */
export function neutralizeTrailers(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (TRAILER_LINE.test(line) ? `> ${line}` : line))
    .join("\n");
}

/** A name that is safe in a Git identity line. */
const cleanName = (name: string) =>
  name
    .replace(/[<>\n\r\0]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "participant";

/**
 * How a participant is written in a commit (§24.3): agents as `<name> <agent-id@agents.<domain>>`.
 * Humans have no linked GitHub identity in the platform yet, so they get
 * `<name> <participant-id@users.<domain>>`.
 */
export function identityOf(person: Contributor, domain: string): { name: string; email: string } {
  const where = person.kind === "AGENT" ? "agents" : "users";
  return { name: cleanName(person.display_name), email: `${person.id}@${where}.${domain}` };
}

interface Pending {
  /** What this commit is: its message, its workspace revision, who wrote it and who else gets credit. */
  message: string;
  /** The commit's author: the checkpoint's creator. */
  author_id: string;
  revision: number;
  at: Date;
  contributors: string[];
}

/**
 * Register `checkpoints.export { checkpoint_id?, mode?, branch? }` (T805, §24.3): put the room's
 * work on a `room/<slug>` branch of its upstream repository.
 *
 * - **squashed** (default): one commit per checkpoint not yet exported, up to the one named
 *   (default the latest), each holding all the changes since the previous checkpoint;
 * - **per_changeset**: one commit per applied ChangeSet in that range (a pulled upstream change is
 *   already upstream, so it gets none).
 *
 * Every commit's tree is the workspace's tree at that revision, byte for byte. The commit's
 * author is the checkpoint's creator; every other participant whose ChangeSets went into it gets
 * a `Co-authored-by:` trailer (agents as `<agent-id@agents.<domain>>`). Dates are the
 * checkpoint's or ChangeSet's own, so exporting the same range twice makes the same commits.
 * The first commit's parent is the commit the room last synced from upstream, later ones follow
 * the previous export. The branch must start with `room/`: anything else is `VALIDATION`
 * (`branch_not_allowed`) and nothing is pushed; the default and protected branches are never
 * pushed to. The push goes through the upstream's {@link UpstreamDeps.credentials} (with
 * `write` access), is never forced, and a branch that moved on is `push_rejected`, and an
 * upstream that no longer has the commit the room was imported or last pulled from is
 * `upstream_history_missing` (pull from the upstream again or re-import, then export). A checkpoint
 * already exported is `already_exported`. Emits `checkpoint.exported`.
 *
 * The push runs inside the command, so the room's lease is held while it runs.
 */
export function registerCheckpointExport(dispatcher: Dispatcher, deps: UpstreamDeps = {}): void {
  const pusher = deps.pusher ?? new HttpsGitPusher(deps.resolve ? { resolve: deps.resolve } : {});
  const credentials = deps.credentials ?? noCredentials;
  const domain = deps.platformDomain ?? DEFAULT_PLATFORM_DOMAIN;
  const pullRequests = deps.pullRequests;
  dispatcher.registerCommand({
    method: "checkpoints.export",
    mutating: true,
    params: checkpointsExportParams,
    execute: async (ctx, p) => {
      const { client, room_id } = ctx;
      const refuse = (reason: string, message: string, details: Record<string, unknown> = {}) =>
        new CrossoverError("VALIDATION", message, { details: { reason, ...details } });

      const { rows: roomRows } = await client.query<{ slug: string }>(
        "SELECT slug FROM rooms WHERE id = $1",
        [room_id],
      );
      const branch = p.branch ?? `room/${roomRows[0]?.slug ?? ""}`;
      if (!branch.startsWith("room/") || !validBranch(branch)) {
        throw refuse("branch_not_allowed", "Only room/* branches can be pushed to", { branch });
      }
      const { rows: workspaces } = await client.query<{ id: string; repo_path: string }>(
        "SELECT id, repo_path FROM workspaces WHERE room_id = $1 FOR UPDATE",
        [room_id],
      );
      const ws = workspaces[0];
      if (!ws) throw new CrossoverError("NOT_FOUND", "Workspace not provisioned");
      const { rows: ups } = await client.query<{
        url: string;
        branch: string;
        last_synced_sha: string;
      }>("SELECT url, branch, last_synced_sha FROM upstreams WHERE room_id = $1", [room_id]);
      const upstream = ups[0];
      if (!upstream) throw refuse("no_upstream", "This room has no upstream repository to push to");
      if (p.pull_request) {
        // Before anything is pushed: no capability, nothing happens.
        if (!pullRequests) {
          throw refuse("no_pull_request_provider", "No pull request provider is configured");
        }
        await ctx.authorize(`github.create_pull_request:${githubRepositoryFromUrl(upstream.url)}`);
      }

      const { rows: checkpoints } = await client.query<{
        id: string;
        revision: string;
        message: string;
        created_by: string;
        created_at: Date;
      }>(
        `SELECT id, revision, message, created_by, created_at FROM checkpoints
         WHERE room_id = $1 ORDER BY revision`,
        [room_id],
      );
      const target =
        p.checkpoint_id === undefined
          ? checkpoints[checkpoints.length - 1]
          : checkpoints.find((c) => c.id === p.checkpoint_id);
      if (!target) {
        throw p.checkpoint_id === undefined
          ? refuse("no_checkpoint", "The room has no checkpoint to export")
          : new CrossoverError("NOT_FOUND", `Checkpoint ${p.checkpoint_id} not found`);
      }

      // Where the last export to this branch got to.
      const { rows: last } = await client.query<{ through: string | null; tip: string | null }>(
        `SELECT payload ->> 'through_revision' AS through, payload ->> 'tip' AS tip
         FROM events WHERE room_id = $1 AND type = 'checkpoint.exported'
           AND payload ->> 'branch' = $2
         ORDER BY sequence DESC LIMIT 1`,
        [room_id, branch],
      );
      const exportedThrough = last[0]?.through ? Number(last[0].through) : 0;
      if (Number(target.revision) <= exportedThrough) {
        throw refuse("already_exported", "That checkpoint is already on the branch", {
          branch,
          through_revision: exportedThrough,
        });
      }
      const options = { gitDir: ws.repo_path, timeoutMs: 60_000 };
      const parent0 = last[0]?.tip ?? upstream.last_synced_sha;
      try {
        await git(["cat-file", "-e", `${parent0}^{commit}`], options);
      } catch {
        throw refuse("parent_missing", "The commit to build on isn't in the room repository");
      }

      // What goes into each commit.
      const pendingCheckpoints = checkpoints.filter(
        (c) =>
          Number(c.revision) > exportedThrough && Number(c.revision) <= Number(target.revision),
      );
      const people = new Map<string, Contributor>();
      const person = async (id: string): Promise<Contributor | undefined> => {
        if (id === UPSTREAM_ACTOR) return undefined;
        if (!people.has(id)) {
          const { rows } = await client.query<Contributor>(
            "SELECT id, kind, display_name FROM participants WHERE id = $1 AND room_id = $2",
            [id, room_id],
          );
          if (rows[0]) people.set(id, rows[0]);
        }
        return people.get(id);
      };
      const commits: Pending[] = [];
      if (p.mode === "squashed") {
        let from = exportedThrough;
        for (const c of pendingCheckpoints) {
          const { rows } = await client.query<{ actor_id: string }>(
            `SELECT DISTINCT actor_id FROM changesets
             WHERE room_id = $1 AND status = 'APPLIED' AND applied_revision > $2
               AND applied_revision <= $3 AND source <> 'UPSTREAM'
             ORDER BY actor_id`,
            [room_id, from, Number(c.revision)],
          );
          commits.push({
            message: c.message,
            author_id: c.created_by,
            revision: Number(c.revision),
            at: c.created_at,
            contributors: rows.map((r) => r.actor_id),
          });
          from = Number(c.revision);
        }
      } else {
        const { rows } = await client.query<{
          applied_revision: string;
          actor_id: string;
          message: string;
          applied_at: Date;
        }>(
          `SELECT applied_revision, actor_id, message, applied_at FROM changesets
           WHERE room_id = $1 AND status = 'APPLIED' AND source <> 'UPSTREAM'
             AND applied_revision > $2 AND applied_revision <= $3
           ORDER BY applied_revision`,
          [room_id, exportedThrough, Number(target.revision)],
        );
        for (const r of rows) {
          commits.push({
            message: r.message,
            author_id: target.created_by,
            revision: Number(r.applied_revision),
            at: r.applied_at,
            contributors: [r.actor_id],
          });
        }
        // The checkpoint's own revision always ends the branch at the checkpointed tree.
        if (commits[commits.length - 1]?.revision !== Number(target.revision)) {
          commits.push({
            message: target.message,
            author_id: target.created_by,
            revision: Number(target.revision),
            at: target.created_at,
            contributors: [],
          });
        }
      }

      let parent = parent0;
      const made: string[] = [];
      for (const commit of commits) {
        const creator = await person(commit.author_id);
        if (!creator) throw refuse("creator_gone", "A checkpoint's creator isn't in the room");
        const author = identityOf(creator, domain);
        const { rows: rev } = await client.query<{ commit_sha: string }>(
          "SELECT commit_sha FROM workspace_revisions WHERE room_id = $1 AND revision = $2",
          [room_id, commit.revision],
        );
        if (!rev[0]) throw new CrossoverError("NOT_FOUND", `Revision ${commit.revision} not found`);
        const tree = (
          await git(["rev-parse", `${rev[0].commit_sha}^{tree}`], options)
        ).stdout.trim();
        const trailers: string[] = [];
        for (const id of commit.contributors) {
          if (id === creator.id) continue;
          const who = await person(id);
          if (!who) continue;
          const identity = identityOf(who, domain);
          const line = `Co-authored-by: ${identity.name} <${identity.email}>`;
          if (!trailers.includes(line)) trailers.push(line);
        }
        // The platform's own trailer block always ends the message, and trailer-shaped lines in
        // the user's text are defused, so nobody can write a `Co-authored-by:` of their own (a
        // trailer is only read from the last paragraph).
        const text = [
          neutralizeTrailers(commit.message.trim()),
          "",
          [`Crossover-Room: ${room_id}`, ...trailers].join("\n"),
          "",
        ].join("\n");
        const date = commit.at.toISOString();
        const sha = (
          await git(["commit-tree", tree, "-p", parent], {
            ...options,
            input: text,
            env: {
              GIT_AUTHOR_NAME: author.name,
              GIT_AUTHOR_EMAIL: author.email,
              GIT_AUTHOR_DATE: date,
              GIT_COMMITTER_NAME: "Crossover",
              GIT_COMMITTER_EMAIL: `system@${domain}`,
              GIT_COMMITTER_DATE: date,
            },
          })
        ).stdout.trim();
        made.push(sha);
        parent = sha;
      }

      const url = await assertPublicHttpsUrl(upstream.url, deps.resolve);
      const lease = await credentials.credentialFor(url, {
        room_id,
        invocation_id: ctx.command_id,
        access: "write",
        permissions: p.pull_request
          ? { contents: "write", pull_requests: "write" }
          : { contents: "write" },
      });
      const credential = lease?.credential ?? null;

      let pullRequest: { url: string; number: number } | undefined;
      let revokeFailed = false;
      try {
        await pusher.push({
          url: url.href,
          branch,
          credential,
          repo: ws.repo_path,
          commit: parent,
        });
        if (p.pull_request && pullRequests) {
          try {
            pullRequest = await pullRequests.create({
              url: url.href,
              head: branch,
              base: upstream.branch,
              title: p.pull_request.title ?? target.message,
              body:
                p.pull_request.body ??
                `Exported from room ${roomRows[0]?.slug ?? room_id}:\n\n${pendingCheckpoints
                  .map((c) => `- ${c.message}`)
                  .join("\n")}`,
              credential,
            });
          } catch (error) {
            // The branch is pushed and the commits are deterministic: exporting again retries this.
            // What the provider says may carry the credential it was given: scrub it.
            if (error instanceof CrossoverError) {
              throw new CrossoverError(error.code, scrub(error.message, credential), {
                retryable: error.retryable,
                ...(error.details
                  ? {
                      details: JSON.parse(
                        scrub(JSON.stringify(error.details), credential),
                      ) as Record<string, unknown>,
                    }
                  : {}),
              });
            }
            const text = scrub(error instanceof Error ? error.message : String(error), credential);
            throw refuse("pull_request_failed", "The pull request couldn't be opened", {
              message: text.split("\n")[0]?.slice(0, 300) ?? "",
            });
          }
        }
      } finally {
        try {
          await lease?.revoke();
        } catch {
          revokeFailed = true;
        }
      }
      if (revokeFailed)
        throw new CrossoverError("PROVIDER_UNAVAILABLE", "Upstream credential revocation failed");
      const payload = {
        checkpoint_id: target.id,
        checkpoint_ids: pendingCheckpoints.map((c) => c.id),
        mode: p.mode,
        branch,
        through_revision: Number(target.revision),
        tip: parent,
        commit_count: made.length,
        commits: made.slice(-MAX_LISTED_COMMITS),
        exported_by: ctx.principal.participant_id,
        ...(pullRequest ? { pull_request: pullRequest } : {}),
      };
      return {
        response: { ...payload, url: url.href },
        events: [{ type: "checkpoint.exported" as const, payload }],
      };
    },
  });
}
