import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import { git } from "./git.js";
import type { SearchBackend, SearchMatch, SearchRequest } from "./search-backend.js";
import { globToRegExpSource } from "./search-glob.js";

const MAX_BODY = 32 * 1024 * 1024;
const MAX_MATCHES = 10_000;
const searchErrorSchema = z.object({ Error: z.string().min(1) });
const listSchema = z.object({
  List: z.object({
    Repos: z.array(
      z.object({
        Repository: z.object({
          Name: z.string(),
          Branches: z.array(z.object({ Name: z.string(), Version: z.string() })),
        }),
      }),
    ),
  }),
});
const searchSchema = z.object({
  Result: z.object({
    Files: z
      .array(
        z.object({
          FileName: z.string(),
          Repository: z.string(),
          Version: z.string(),
          LineMatches: z.array(
            z.object({ Line: z.string(), LineNumber: z.number().int().positive() }),
          ),
        }),
      )
      .nullable(),
    MatchCount: z.number().int().nonnegative(),
    FilesSkipped: z.number().int().nonnegative(),
    ShardsSkipped: z.number().int().nonnegative(),
  }),
});

export interface ZoektBackendOptions {
  url: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function quote(value: string): string {
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

/** Build the room-scoped RE2 query; null means ripgrep must handle it. */
export function zoektQuery(
  request: Pick<SearchRequest, "room_id" | "query" | "regex" | "case_sensitive" | "glob">,
): string | null {
  if (!/^room_[0-9A-Za-z]+$/.test(request.room_id) || /[\r\n]/.test(request.query)) return null;
  const glob = request.glob === undefined ? undefined : globToRegExpSource(request.glob);
  if (glob === null) return null;
  // RE2 and ripgrep's Rust regex disagree on these extensions; use ripgrep's error path.
  if (request.regex && /\\[1-9]|\(\?(?:[=!]|<[=!])/.test(request.query)) return null;
  const content = request.regex
    ? request.query
    : request.query.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&");
  return `repo:^${request.room_id}$ case:${request.case_sensitive ? "yes" : "no"} content:${quote(content)}${glob === undefined ? "" : ` file:${quote(glob)}`}`;
}

async function boundedJson(response: Response): Promise<unknown | null> {
  if (!response.body) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_BODY) {
      return null;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

async function pathModes(
  request: SearchRequest,
  paths: string[],
): Promise<Map<string, string> | null> {
  const modes = new Map<string, string>();
  try {
    for (let offset = 0; offset < paths.length; offset += 500) {
      const batch = paths.slice(offset, offset + 500);
      const { stdout } = await git(["ls-tree", "-r", "-z", request.commit, "--", ...batch], {
        gitDir: request.repo_path,
        timeoutMs: 10_000,
        encoding: "buffer",
        maxBuffer: MAX_BODY,
      });
      for (const record of stdout.toString("utf8").split("\0")) {
        if (!record) continue;
        const match = /^(\d{6}) (?:blob|commit) [0-9a-f]+\t([\s\S]+)$/.exec(record);
        if (!match) return null;
        modes.set(match[2]!, match[1]!);
      }
    }
  } catch {
    return null;
  }
  return paths.every((path) => modes.has(path)) ? modes : null;
}

/** Use the index only when it is complete and exactly at the requested DB head. */
export function zoektBackend(options: ZoektBackendOptions): SearchBackend {
  const runFetch = options.fetch ?? fetch;
  const lastDecline = new Map<string, number>();
  const decline = (room: string, reason: string): null => {
    const now = Date.now();
    if (now - (lastDecline.get(room) ?? 0) >= 60_000) {
      console.warn(`zoekt search declined: ${reason}`);
      lastDecline.set(room, now);
    }
    return null;
  };
  return {
    name: "zoekt",
    async search(request, sink) {
      if (!request.is_head) return null;
      const query = zoektQuery(request);
      if (!query) return decline(request.room_id, "query");
      const timeout = Math.min(Math.max(options.timeoutMs ?? 6_000, 1), 6_000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const post = (path: string, body: unknown) =>
        runFetch(new URL(path, options.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      try {
        const listed = await post("api/list", { Q: `repo:^${request.room_id}$` });
        if (listed.status !== 200) return decline(request.room_id, "list_status");
        const list = listSchema.safeParse(await boundedJson(listed));
        if (!list.success) return decline(request.room_id, "list_shape");
        const repo = list.data.List.Repos[0]?.Repository;
        if (
          repo?.Name !== request.room_id ||
          repo.Branches.find((b) => b.Name === "head")?.Version !== request.commit
        )
          return decline(request.room_id, "stale_index");

        const response = await post("api/search", {
          Q: query,
          Opts: {
            ChunkMatches: false,
            NumContextLines: 0,
            TotalMaxMatchCount: MAX_MATCHES,
            ShardMaxMatchCount: MAX_MATCHES,
            MaxWallTime: 5_000_000_000,
          },
        });
        if (response.status === 400) {
          if (!searchErrorSchema.safeParse(await boundedJson(response)).success)
            return decline(request.room_id, "search_shape");
          throw new CrossoverError("VALIDATION", "Invalid search", {
            details: { reason: "invalid_search" },
          });
        }
        if (response.status !== 200) return decline(request.room_id, "search_status");
        const parsed = searchSchema.safeParse(await boundedJson(response));
        if (!parsed.success) return decline(request.room_id, "search_shape");
        const { Files: files, MatchCount, FilesSkipped, ShardsSkipped } = parsed.data.Result;
        if (FilesSkipped || ShardsSkipped) return decline(request.room_id, "incomplete");
        const matches: SearchMatch[] = [];
        for (const file of files ?? []) {
          if (file.Repository !== request.room_id || file.Version !== request.commit)
            return decline(request.room_id, "version_race");
          for (const line of file.LineMatches) {
            if (matches.length === MAX_MATCHES) return decline(request.room_id, "match_limit");
            matches.push({
              path: file.FileName,
              line: line.LineNumber,
              text: Buffer.from(line.Line, "base64")
                .toString("utf8")
                .replace(/\r?\n$/, ""),
            });
          }
        }
        const modes = await pathModes(request, [...new Set(matches.map((match) => match.path))]);
        if (!modes) return decline(request.room_id, "path_modes");
        matches.sort(
          (a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)) || a.line - b.line,
        );
        for (const match of matches) {
          if (["120000", "160000"].includes(modes.get(match.path)!)) continue;
          if (!(await sink(match))) return { truncated: true };
        }
        return { truncated: MatchCount >= MAX_MATCHES };
      } catch (error) {
        if (error instanceof CrossoverError) throw error;
        return decline(request.room_id, "unavailable");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
