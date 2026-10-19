import { CrossoverError } from "@crossover/protocol";
import { gitStream, GitError } from "./git.js";
import { normalizePath, PathValidationError } from "./path.js";
import type { SearchBackend } from "./search-backend.js";
import { SEARCH_TIMEOUT_MS } from "./search-backend.js";
import { globToRegExpSource } from "./search-glob.js";

/** Search historical commits directly, without materializing or indexing a checkout. */
export const gitGrepBackend: SearchBackend = {
  name: "git_grep",
  async search(request, sink) {
    if (request.is_head) return null;
    const glob = request.glob === undefined ? undefined : globToRegExpSource(request.glob);
    if (request.glob !== undefined && glob === null)
      throw new CrossoverError("VALIDATION", "Glob is unsupported for historical search", {
        details: { reason: "glob_unsupported_for_revision" },
      });
    const pathMatches = glob == null ? undefined : new RegExp(glob, "u");
    const args = [
      "grep",
      "-z",
      "-n",
      "-I",
      "--no-color",
      request.regex ? "-P" : "-F",
      ...(request.case_sensitive ? [] : ["-i"]),
      "-e",
      request.query,
      request.commit,
      "--",
    ];
    let field = 0;
    let fieldChunks: Buffer[] = [];
    let fieldLength = 0;
    let path = "";
    let line = 0;
    let truncated = false;
    const invalidOutput = () =>
      new CrossoverError("VALIDATION", "Invalid search result from Git", {
        details: { reason: "invalid_search" },
      });

    try {
      const result = await gitStream(
        args,
        { gitDir: request.repo_path, timeoutMs: SEARCH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
        async (chunk) => {
          let start = 0;
          while (start < chunk.length) {
            const delimiter = field === 2 ? 0x0a : 0x00;
            const offset = chunk.indexOf(delimiter, start);
            if (offset < 0) {
              const rest = chunk.subarray(start);
              fieldChunks.push(rest);
              fieldLength += rest.length;
              return true;
            }
            const tail = chunk.subarray(start, offset);
            const value =
              fieldChunks.length === 0
                ? tail
                : Buffer.concat([...fieldChunks, tail], fieldLength + tail.length);
            fieldChunks = [];
            fieldLength = 0;
            start = offset + 1;
            if (field === 0) {
              const rawPath = value.toString("utf8");
              const prefix = `${request.commit}:`;
              if (!rawPath.startsWith(prefix)) throw invalidOutput();
              path = rawPath.slice(prefix.length);
              field = 1;
            } else if (field === 1) {
              const number = value.toString("ascii");
              if (!/^[1-9]\d*$/.test(number)) throw invalidOutput();
              line = Number(number);
              if (!Number.isSafeInteger(line)) throw invalidOutput();
              field = 2;
            } else {
              const text = value.toString("utf8").replace(/\r$/, "");
              field = 0;
              let safePath: string;
              try {
                safePath = normalizePath(path);
              } catch (error) {
                if (error instanceof PathValidationError) continue;
                throw error;
              }
              if (pathMatches && !pathMatches.test(safePath)) continue;
              if (!(await sink({ path: safePath, line, text }))) {
                truncated = true;
                return false;
              }
            }
          }
          return true;
        },
      );
      if (fieldLength !== 0 || field !== 0) {
        if (!result.truncated) throw invalidOutput();
      }
      return { truncated: truncated || result.truncated };
    } catch (error) {
      if (error instanceof GitError) {
        if (error.timedOut)
          throw new CrossoverError("VALIDATION", "Search timed out", {
            details: { reason: "search_timeout" },
          });
        throw new CrossoverError("VALIDATION", "Invalid search", {
          details: { reason: "invalid_search", diagnostic: error.stderr.slice(0, 8192) },
        });
      }
      throw error;
    }
  },
};
