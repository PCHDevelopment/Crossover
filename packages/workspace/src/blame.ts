import { isUtf8 } from "node:buffer";
import type { Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import { attribution } from "./attribution.js";
import { BINARY_SIZE } from "./binary.js";
import { git } from "./git.js";
import { entries, pathSchema, snapshot } from "./reads.js";

function invalid(path: string, reason: string): never {
  throw new CrossoverError("VALIDATION", `Cannot blame workspace path: ${path}`, {
    details: { path, reason },
  });
}

/** Attribute 1-based half-open line ranges to committed ChangeSets (§9.1, §9.6). */
export function registerWorkspaceBlame(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "workspace.blame",
    action: "workspace.read",
    perPathAuthorize: true,
    mutating: false,
    params: z.strictObject({
      path: pathSchema(),
      revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    }),
    execute: async (ctx, params) => {
      await ctx.authorize("workspace.read", { path: params.path });
      const ws = await snapshot(ctx, params.revision);
      const entry = (await entries(ws.repo_path, ws.commit, params.path)).find(
        (entry) => entry.path === params.path,
      );
      if (!entry) throw new CrossoverError("NOT_FOUND", "Workspace path not found");
      if (entry.type !== "file") invalid(params.path, "not_a_file");
      if (entry.size! > BINARY_SIZE) invalid(params.path, "blame_not_supported");
      const { stdout: content } = await git(["cat-file", "blob", entry.oid], {
        gitDir: ws.repo_path,
        timeoutMs: 10_000,
        encoding: "buffer",
      });
      if (content.subarray(0, 8192).includes(0) || !isUtf8(content))
        invalid(params.path, "blame_not_supported");
      let line_count = 0;
      for (const byte of content) if (byte === 10) line_count++;
      if (content.length && content.at(-1) !== 10) line_count++;
      const attributed = await attribution(ws.repo_path, ws.commit, params.path);
      const { rows } = await ctx.client.query<{
        commit_sha: string;
        revision: string;
        actor_id: string;
      }>(
        `SELECT wr.commit_sha, wr.revision, cs.actor_id FROM workspace_revisions wr
         JOIN changesets cs ON cs.id = wr.changeset_id AND cs.room_id = wr.room_id
           AND cs.workspace_id = wr.workspace_id
         WHERE wr.room_id = $1 AND wr.workspace_id = $2 AND wr.revision <= $3
           AND wr.commit_sha = ANY($4::text[])`,
        [ctx.room_id, ws.id, ws.revision, [...new Set(attributed.map((range) => range.commit))]],
      );
      const revisions = new Map(
        rows.map((row) => [
          row.commit_sha,
          {
            workspace_revision: Number(row.revision),
            actor_id: row.actor_id,
          },
        ]),
      );
      const ranges: {
        start: number;
        end: number;
        workspace_revision: number;
        actor_id: string | null;
      }[] = [];
      for (const range of attributed.sort((a, b) => a.start - b.start)) {
        const origin = revisions.get(range.commit) ?? { workspace_revision: 0, actor_id: null };
        const previous = ranges.at(-1);
        if (
          previous?.end === range.start &&
          previous.workspace_revision === origin.workspace_revision &&
          previous.actor_id === origin.actor_id
        )
          previous.end += range.count;
        else ranges.push({ start: range.start, end: range.start + range.count, ...origin });
      }
      return { response: { workspace_revision: ws.revision, line_count, ranges } };
    },
  });
}
