import type { Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import { normalizePath, PathValidationError } from "./path.js";
import { snapshot } from "./reads.js";
import {
  ripgrepBackend,
  type SearchBackend,
  type SearchBackendName,
  type SearchMatch,
} from "./search-backend.js";
import { gitGrepBackend } from "./search-git-grep.js";

const input = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
export const workspaceSearchParamsSchema = z.strictObject({
  query: input,
  regex: z.boolean().default(false),
  case_sensitive: z.boolean().default(true),
  glob: input.optional(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

export interface WorkspaceSearchDeps {
  headBackends?: SearchBackend[];
  onBackend?: (name: SearchBackendName) => void;
}

/** Search a committed revision (§9.5); forbidden paths never enter the public response. */
export function registerWorkspaceSearch(
  dispatcher: Dispatcher,
  deps: WorkspaceSearchDeps = {},
): void {
  dispatcher.registerCommand({
    method: "workspace.search",
    action: "workspace.read",
    // Each match is authorized by its path before it is returned.
    perPathAuthorize: true,
    mutating: false,
    view: "participant",
    params: workspaceSearchParamsSchema,
    execute: async (ctx, params) => {
      const ws = await snapshot(ctx, params.revision);
      const head = params.revision === undefined ? ws : await snapshot(ctx);
      const isHead = ws.revision === head.revision;
      const matches: (SearchMatch & { text_truncated?: true })[] = [];
      let bytes = Buffer.byteLength(
        JSON.stringify({ workspace_revision: ws.revision, matches, truncated: false }),
      );
      const allowed = new Map<string, boolean>();
      const sink = async (match: SearchMatch): Promise<boolean> => {
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
      };
      const request = {
        room_id: ctx.room_id,
        repo_path: ws.repo_path,
        commit: ws.commit,
        revision: ws.revision,
        is_head: isHead,
        query: params.query,
        regex: params.regex,
        case_sensitive: params.case_sensitive,
        ...(params.glob === undefined ? {} : { glob: params.glob }),
      };
      const backends = isHead ? (deps.headBackends ?? [ripgrepBackend]) : [gitGrepBackend];
      let result: { truncated: boolean } | null = null;
      for (const backend of backends) {
        result = await backend.search(request, sink);
        if (result !== null) {
          deps.onBackend?.(backend.name);
          break;
        }
      }
      if (result === null)
        throw new CrossoverError("UNAVAILABLE", "No search backend can serve this revision", {
          details: { reason: "no_search_backend" },
        });
      return {
        response: {
          workspace_revision: ws.revision,
          matches,
          truncated: result.truncated,
        },
      };
    },
  });
}

export type { SearchMatch } from "./search-backend.js";
