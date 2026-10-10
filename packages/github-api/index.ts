import { Buffer } from "node:buffer";

const DEFAULT_BASE_URL = "https://api.github.com";
const MAX_DIRECTORY_ENTRIES = 1_000;
const MAX_INLINE_FILE_BYTES = 128 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;

export type GitHubErrorCode =
  "not_found" | "forbidden" | "rate_limited" | "validation" | "unavailable";

export class GitHubApiError extends Error {
  constructor(
    readonly code: GitHubErrorCode,
    message: string,
    options: { retryable?: boolean; retry_after?: number } = {},
  ) {
    super(message);
    this.name = "GitHubApiError";
    this.retryable = options.retryable ?? false;
    if (options.retry_after !== undefined) this.retry_after = options.retry_after;
  }

  readonly retryable: boolean;
  readonly retry_after?: number;
}

export interface GitHubRepository {
  type: "repository";
  full_name: string;
  default_branch: string;
  private: boolean;
  description: string | null;
  html_url: string;
}

export interface GitHubDirectory {
  type: "dir";
  path: string;
  entries: Array<{ name: string; path: string; type: string; size: number }>;
  truncated: boolean;
}

export interface GitHubFile {
  type: "file";
  path: string;
  sha: string;
  size: number;
  encoding: "utf8" | "base64";
  content: string;
}

export interface GitHubLargeFile {
  type: "file";
  too_large: true;
  path: string;
  sha: string;
  size: number;
}

export type GitHubRepositoryContent =
  GitHubRepository | GitHubDirectory | GitHubFile | GitHubLargeFile;

export interface GitHubApiClientOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
}

export interface ReadGitHubRepositoryInput {
  repository: string;
  path?: string;
  ref?: string;
  token: string;
}

export interface CreateGitHubPullRequestInput {
  repository: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
  token: string;
}

export interface GitHubApiClient {
  readRepository(input: ReadGitHubRepositoryInput): Promise<GitHubRepositoryContent>;
  createPullRequest(input: CreateGitHubPullRequestInput): Promise<{
    number: number;
    url: string;
    created: boolean;
  }>;
}

type JsonObject = Record<string, unknown>;
type RequestOptions = { method?: string; body?: string };

export function normalizeGitHubRepository(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 140 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_-])?$/.test(
      value,
    )
  ) {
    throw new GitHubApiError("validation", "GitHub repository scope is invalid");
  }
  return value.toLowerCase();
}

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header && /^\d+$/.test(header)) return Number(header);
  if (header) {
    const milliseconds = Date.parse(header) - Date.now();
    if (Number.isFinite(milliseconds)) return Math.max(0, Math.ceil(milliseconds / 1_000));
  }
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset))
    return Math.max(0, Number(reset) - Math.floor(Date.now() / 1_000));
  return undefined;
}

function apiError(response: Response): GitHubApiError {
  const retry_after = retryAfterSeconds(response);
  const rateLimited =
    response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0";
  if (rateLimited)
    return new GitHubApiError("rate_limited", "GitHub rate limit reached", {
      retryable: true,
      ...(retry_after === undefined ? {} : { retry_after }),
    });
  if (response.status === 404) return new GitHubApiError("not_found", "GitHub resource not found");
  if (response.status === 401 || response.status === 403)
    return new GitHubApiError("forbidden", "GitHub denied access to this resource");
  if (response.status === 422)
    return new GitHubApiError("validation", "GitHub rejected the request");
  if (response.status >= 500)
    return new GitHubApiError("unavailable", "GitHub service unavailable", { retryable: true });
  return new GitHubApiError("unavailable", "GitHub API request failed", { retryable: false });
}

function validObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathFor(repository: string, tail: string): string {
  const [owner, name] = repository.split("/");
  return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}${tail}`;
}

function safePath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length > 1_024 ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    path.includes("\\") ||
    Array.from(path).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    throw new GitHubApiError("validation", "Repository path is invalid");
  return path;
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function safeRef(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  )
    throw new GitHubApiError("validation", "Repository ref is invalid");
  return value;
}

function safeBranch(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("@{")
  )
    throw new GitHubApiError("validation", `${label} branch is invalid`);
  return value;
}

export function createGitHubApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetcher = fetch,
}: GitHubApiClientOptions = {}): GitHubApiClient {
  let origin: string;
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("invalid base URL");
    origin = parsed.href.replace(/\/$/, "");
  } catch {
    throw new GitHubApiError("validation", "GitHub API base URL is invalid");
  }

  const request = async (
    path: string,
    token: string,
    init: RequestOptions = {},
  ): Promise<unknown> => {
    if (typeof token !== "string" || token.length === 0 || /[\0\r\n]/.test(token))
      throw new GitHubApiError("forbidden", "GitHub credential is unavailable");
    let response: Response;
    try {
      response = await fetcher(`${origin}${path}`, {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GitHubApiError("unavailable", "GitHub service unavailable", { retryable: true });
    }
    if (!response.ok) throw apiError(response);
    if (response.status === 204) return null;
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new GitHubApiError("unavailable", "GitHub returned an invalid response");
    }
  };

  const repositoryMetadata = async (
    repository: string,
    token: string,
  ): Promise<GitHubRepository> => {
    const payload = await request(pathFor(repository, ""), token);
    if (
      !validObject(payload) ||
      typeof payload["full_name"] !== "string" ||
      typeof payload["default_branch"] !== "string" ||
      typeof payload["private"] !== "boolean"
    )
      throw new GitHubApiError("unavailable", "GitHub returned an invalid repository");
    const description = payload["description"];
    return {
      type: "repository",
      full_name: payload["full_name"].slice(0, 300),
      default_branch: payload["default_branch"].slice(0, 200),
      private: payload["private"],
      description: typeof description === "string" ? description.slice(0, 2_000) : null,
      html_url: `https://github.com/${repository}`,
    };
  };

  const readDirectory = async (
    repository: string,
    path: string,
    ref: string | undefined,
    token: string,
    payload: unknown[],
  ): Promise<GitHubDirectory> => {
    const entries = payload
      .filter(validObject)
      .map((item) => {
        const size = item["size"];
        return {
          name: typeof item["name"] === "string" ? item["name"].slice(0, 255) : "",
          path: typeof item["path"] === "string" ? item["path"].slice(0, 1_024) : "",
          type: typeof item["type"] === "string" ? item["type"].slice(0, 32) : "unknown",
          size: typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : 0,
        };
      })
      .filter((item) => item.name && item.path);
    let truncated = entries.length > MAX_DIRECTORY_ENTRIES;
    if (entries.length === MAX_DIRECTORY_ENTRIES) {
      let treeRef = ref;
      if (!treeRef) {
        const metadata = await repositoryMetadata(repository, token);
        treeRef = metadata.default_branch;
      }
      const tree = await request(
        pathFor(repository, `/git/trees/${encodeURIComponent(treeRef)}?recursive=1`),
        token,
      );
      if (!validObject(tree) || !Array.isArray(tree["tree"]))
        throw new GitHubApiError("unavailable", "GitHub returned an invalid repository tree");
      const treeEntries = tree["tree"];
      const prefix = `${path}/`;
      const direct = treeEntries.filter((item) => {
        if (
          !validObject(item) ||
          typeof item["path"] !== "string" ||
          !item["path"].startsWith(prefix)
        )
          return false;
        return !item["path"].slice(prefix.length).includes("/");
      });
      truncated = tree["truncated"] === true || direct.length > MAX_DIRECTORY_ENTRIES;
    }
    return {
      type: "dir",
      path,
      entries: entries.slice(0, MAX_DIRECTORY_ENTRIES),
      truncated,
    };
  };

  const pullRequestUrl = (repository: string, number: number): string =>
    `https://github.com/${repository}/pull/${number}`;

  const findOpenPullRequest = async (
    repository: string,
    head: string,
    base: string,
    token: string,
  ): Promise<{ number: number; url: string; created: false } | undefined> => {
    const owner = repository.split("/")[0]!;
    const query = new URLSearchParams({
      state: "open",
      head: `${owner}:${head}`,
      base,
      per_page: "100",
    });
    const payload = await request(pathFor(repository, `/pulls?${query}`), token);
    if (!Array.isArray(payload))
      throw new GitHubApiError("unavailable", "GitHub returned an invalid pull request list");
    const found = payload.find((item) => {
      if (!validObject(item) || item["state"] !== "open") return false;
      const itemHead = item["head"];
      const itemBase = item["base"];
      if (!validObject(itemHead) || !validObject(itemBase)) return false;
      const headRepo = itemHead["repo"];
      if (!validObject(headRepo)) return false;
      const number = item["number"];
      return (
        itemHead["ref"] === head &&
        typeof headRepo["full_name"] === "string" &&
        headRepo["full_name"].toLowerCase() === repository &&
        itemBase["ref"] === base &&
        typeof number === "number" &&
        Number.isSafeInteger(number) &&
        number > 0
      );
    });
    if (!validObject(found) || typeof found["number"] !== "number") return undefined;
    return {
      number: found["number"],
      url: pullRequestUrl(repository, found["number"]),
      created: false,
    };
  };

  return {
    async readRepository({ repository: rawRepository, path, ref, token }) {
      const repository = normalizeGitHubRepository(rawRepository);
      if (path === undefined) return repositoryMetadata(repository, token);
      const safe = safePath(path);
      const safeReference = ref === undefined ? undefined : safeRef(ref);
      const query = safeReference === undefined ? "" : `?ref=${encodeURIComponent(safeReference)}`;
      const payload = await request(
        pathFor(repository, `/contents/${encodedPath(safe)}${query}`),
        token,
      );
      if (Array.isArray(payload))
        return readDirectory(repository, safe, safeReference, token, payload);
      if (!validObject(payload) || payload["type"] !== "file")
        throw new GitHubApiError("validation", "GitHub path is not a file or directory");
      const filePath = payload["path"];
      const sha = payload["sha"];
      const size = payload["size"];
      if (
        typeof filePath !== "string" ||
        typeof sha !== "string" ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0
      )
        throw new GitHubApiError("validation", "GitHub returned an invalid file");
      if (size > MAX_INLINE_FILE_BYTES)
        return {
          type: "file",
          too_large: true,
          path: filePath.slice(0, 1_024),
          sha: sha.slice(0, 64),
          size,
        };
      const encoded = payload["content"];
      if (typeof encoded !== "string")
        throw new GitHubApiError("unavailable", "GitHub returned file content without a body");
      const raw = Buffer.from(encoded.replace(/\s/g, ""), "base64");
      if (raw.byteLength !== size)
        throw new GitHubApiError("unavailable", "GitHub returned a file with an invalid size");
      let content = raw.toString("base64");
      let encoding: GitHubFile["encoding"] = "base64";
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        encoding = "utf8";
      } catch {
        // Binary repository files stay base64 encoded.
      }
      const result: GitHubFile = {
        type: "file",
        path: filePath.slice(0, 1_024),
        sha: sha.slice(0, 64),
        size,
        encoding,
        content,
      };
      if (encoding === "utf8" && Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES)
        return { ...result, encoding: "base64", content: raw.toString("base64") };
      return result;
    },

    async createPullRequest({
      repository: rawRepository,
      head: rawHead,
      base: rawBase,
      title,
      body = "",
      draft = false,
      token,
    }) {
      const repository = normalizeGitHubRepository(rawRepository);
      const head = safeBranch(rawHead, "Head");
      const base = safeBranch(rawBase, "Base");
      if (
        typeof title !== "string" ||
        !title.trim() ||
        title.length > 256 ||
        typeof body !== "string" ||
        body.length > 65_536 ||
        typeof draft !== "boolean"
      )
        throw new GitHubApiError("validation", "Pull request details are invalid");
      const existing = await findOpenPullRequest(repository, head, base, token);
      if (existing) return existing;
      let response: unknown;
      let raced = false;
      try {
        response = await request(pathFor(repository, "/pulls"), token, {
          method: "POST",
          body: JSON.stringify({ head, base, title: title.trim(), body, draft }),
        });
      } catch (error) {
        if (error instanceof GitHubApiError && error.code === "validation") {
          const afterRace = await findOpenPullRequest(repository, head, base, token);
          if (afterRace) {
            response = { number: afterRace.number };
            raced = true;
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
      if (!validObject(response))
        throw new GitHubApiError("unavailable", "GitHub returned an invalid pull request");
      const number = response["number"];
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
        throw new GitHubApiError("unavailable", "GitHub returned an invalid pull request");
      return { number, url: pullRequestUrl(repository, number), created: !raced };
    },
  };
}
