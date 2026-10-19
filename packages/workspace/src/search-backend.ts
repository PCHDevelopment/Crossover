import { runSearch, type SearchOptions } from "./search-runner.js";
import { withSearchTree } from "./search-tree.js";

export type SearchBackendName = "ripgrep" | "git_grep" | "zoekt";
export type SearchMatch = { path: string; line: number; text: string };

export interface SearchRequest {
  room_id: string;
  repo_path: string;
  commit: string;
  revision: number;
  is_head: boolean;
  query: string;
  regex: boolean;
  case_sensitive: boolean;
  glob?: string;
}

export type SearchSink = (match: SearchMatch) => Promise<boolean>;

export interface SearchBackend {
  readonly name: SearchBackendName;
  /** Return null when this backend cannot serve the request. */
  search(request: SearchRequest, sink: SearchSink): Promise<{ truncated: boolean } | null>;
}

export const SEARCH_TIMEOUT_MS = 10_000;

export const ripgrepBackend: SearchBackend = {
  name: "ripgrep",
  async search(request, sink) {
    if (!request.is_head) return null;
    return withSearchTree(request.repo_path, request.commit, (tree) =>
      runSearch(tree, toOptions(request), sink),
    );
  },
};

function toOptions(request: SearchRequest): SearchOptions {
  return {
    query: request.query,
    regex: request.regex,
    case_sensitive: request.case_sensitive,
    ...(request.glob === undefined ? {} : { glob: request.glob }),
  };
}
