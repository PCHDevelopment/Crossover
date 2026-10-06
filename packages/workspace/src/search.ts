import type { Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import { normalizePath, PathValidationError } from "./path.js";
import { snapshot } from "./reads.js";
import { runSearch, type SearchMatch } from "./search-runner.js";
import { withSearchTree } from "./search-tree.js";

const input = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));

/** Search the committed head (§9.5); forbidden paths never enter the public response. */
export function registerWorkspaceSearch(dispatcher: Dispatcher): void {
  dispatcher.registerCommand({
    method: "workspace.search",
    action: "workspace.read",
    // Each match is authorized by its path before it is returned.
    perPathAuthorize: true,
    mutating: false,
    params: z.strictObject({
      query: input,
      regex: z.boolean().default(false),
      case_sensitive: z.boolean().default(true),
      glob: input.optional(),
      revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    }),
    execute: async (ctx, params) => {
      const ws = await snapshot(ctx);
      if (params.revision !== undefined && params.revision !== ws.revision)
        throw new CrossoverError("VALIDATION", "Search supports the workspace head only", {
          details: { reason: "search_head_only" },
        });
      return withSearchTree(ws.repo_path, ws.commit, async (tree) => {
        const matches: (SearchMatch & { text_truncated?: true })[] = [];
        let bytes = Buffer.byteLength(
          JSON.stringify({ workspace_revision: ws.revision, matches, truncated: false }),
        );
        const allowed = new Map<string, boolean>();
        const result = await runSearch(
          tree,
          {
            query: params.query,
            regex: params.regex,
            case_sensitive: params.case_sensitive,
            ...(params.glob === undefined ? {} : { glob: params.glob }),
          },
          async (match) => {
            let path: string;
            try {
              path = normalizePath(match.path);
            } catch (error) {
              if (error instanceof PathValidationError) return true;
              throw error;
            }
            if (!allowed.has(path)) {
              try {
                await ctx.authorize("workspace.read", { path });
                allowed.set(path, true);
              } catch (error) {
                if (!(error instanceof CrossoverError) || error.code !== "FORBIDDEN") throw error;
                allowed.set(path, false);
              }
            }
            if (!allowed.get(path)) return true;
            const text = /^.{0,500}/su.exec(match.text)![0];
            const entry = {
              path,
              line: match.line,
              text,
              ...(text.length !== match.text.length ? { text_truncated: true as const } : {}),
            };
            const size = Buffer.byteLength(JSON.stringify(entry)) + (matches.length ? 1 : 0);
            if (matches.length === 200 || bytes + size > 1024 * 1024) return false;
            matches.push(entry);
            bytes += size;
            return true;
          },
        );
        return {
          response: {
            workspace_revision: ws.revision,
            matches,
            truncated: result.truncated,
          },
        };
      });
    },
  });
}
