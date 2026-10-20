import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { initRoomRepo } from "./repo.js";
import type { SearchMatch, SearchRequest } from "./search-backend.js";
import { zoektBackend, zoektQuery } from "./zoekt-search.js";

let root: string;
let repo: string;
let commit: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "zoekt-search-test-"));
  repo = await initRoomRepo(root, "room_A");
  const base = (
    await git(["rev-parse", "refs/room/canonical"], { gitDir: repo, timeoutMs: 10_000 })
  ).stdout.trim();
  const regular = await materialize(repo, base, [
    { type: "create", path: "z.txt", content: "needle\n" },
    { type: "create", path: "a.txt", content: "needle\n" },
  ]);
  const env = { GIT_INDEX_FILE: join(root, "link-index") };
  await git(["read-tree", regular], { gitDir: repo, timeoutMs: 10_000, env });
  const oid = (
    await git(["hash-object", "-w", "--stdin"], { gitDir: repo, timeoutMs: 10_000, input: "z.txt" })
  ).stdout.trim();
  await git(["update-index", "--add", "--cacheinfo", `120000,${oid},link.txt`], {
    gitDir: repo,
    timeoutMs: 10_000,
    env,
  });
  const tree = (await git(["write-tree"], { gitDir: repo, timeoutMs: 10_000, env })).stdout.trim();
  commit = (
    await git(["commit-tree", tree, "-p", regular, "-m", "symlink"], {
      gitDir: repo,
      timeoutMs: 10_000,
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.test",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.test",
      },
    })
  ).stdout.trim();
});
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    room_id: "room_A",
    repo_path: repo,
    commit,
    revision: 1,
    is_head: true,
    query: "needle",
    regex: false,
    case_sensitive: true,
    ...overrides,
  };
}

function listed(version = commit) {
  return {
    List: {
      Repos: [{ Repository: { Name: "room_A", Branches: [{ Name: "head", Version: version }] } }],
    },
  };
}

function found(files: Array<{ path: string; version?: string; lines?: string[] }> = []) {
  return {
    Result: {
      Files: files.map(({ path, version = commit, lines = ["needle"] }) => ({
        FileName: path,
        Repository: "room_A",
        Version: version,
        LineMatches: lines.map((line, i) => ({
          Line: Buffer.from(line).toString("base64"),
          LineNumber: i + 1,
        })),
      })),
      MatchCount: files.length,
      FilesSkipped: 0,
      ShardsSkipped: 0,
    },
  };
}

function fakeFetch(list: unknown = listed(), search: unknown = found()): typeof fetch {
  return vi.fn(async (input: string | URL | Request) =>
    Response.json(String(input).endsWith("/api/list") ? list : search),
  ) as typeof fetch;
}

it("builds escaped, room-scoped queries and declines incompatible regex syntax", () => {
  expect(zoektQuery(request({ query: 'a"b\\c.*' }))).toBe(
    'repo:^room_A$ case:yes content:"a\\"b\\\\\\\\c\\\\.\\\\*"',
  );
  expect(
    zoektQuery(request({ regex: true, query: "^fo+bar$", case_sensitive: false, glob: "docs/**" })),
  ).toContain('case:no content:"^fo+bar$" file:');
  expect(zoektQuery(request({ room_id: "room_A|room_B" }))).toBeNull();
  expect(zoektQuery(request({ query: "a\nb" }))).toBeNull();
  expect(zoektQuery(request({ glob: "{a,b}" }))).toBeNull();
  expect(zoektQuery(request({ regex: true, query: "a(?=b)" }))).toBeNull();
  expect(zoektQuery(request({ regex: true, query: "(a)\\1" }))).toBeNull();
});

it("declines a stale or malformed index before emitting any matches", async () => {
  const sink = vi.fn(async () => true);
  const stale = zoektBackend({ url: "http://127.0.0.1/", fetch: fakeFetch(listed("old")) });
  expect(await stale.search(request(), sink)).toBeNull();
  const malformed = zoektBackend({
    url: "http://127.0.0.1/",
    fetch: fakeFetch(listed(), { Result: {} }),
  });
  expect(await malformed.search(request(), sink)).toBeNull();
  const raced = zoektBackend({
    url: "http://127.0.0.1/",
    fetch: fakeFetch(listed(), found([{ path: "a.txt", version: "old" }])),
  });
  expect(await raced.search(request(), sink)).toBeNull();
  expect(sink).not.toHaveBeenCalled();
});

it("sorts matches, removes symlinks and reports sink truncation", async () => {
  const fetch = fakeFetch(
    listed(),
    found([{ path: "z.txt" }, { path: "link.txt" }, { path: "a.txt", lines: ["needle\r\n"] }]),
  );
  const backend = zoektBackend({ url: "http://127.0.0.1/", fetch });
  const matches: SearchMatch[] = [];
  expect(
    await backend.search(request(), async (match) => {
      matches.push(match);
      return matches.length < 2;
    }),
  ).toEqual({ truncated: true });
  expect(matches).toEqual([
    { path: "a.txt", line: 1, text: "needle" },
    { path: "z.txt", line: 1, text: "needle" },
  ]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("falls back on skipped files and bounds oversized responses", async () => {
  const incomplete = found([{ path: "a.txt" }]);
  incomplete.Result.FilesSkipped = 1;
  const sink = vi.fn(async () => true);
  expect(
    await zoektBackend({ url: "http://127.0.0.1/", fetch: fakeFetch(listed(), incomplete) }).search(
      request(),
      sink,
    ),
  ).toBeNull();
  const oversized = fakeFetch(listed(), { huge: "x".repeat(32 * 1024 * 1024) });
  expect(
    await zoektBackend({ url: "http://127.0.0.1/", fetch: oversized }).search(request(), sink),
  ).toBeNull();
  expect(sink).not.toHaveBeenCalled();
});

it("maps search 400 to invalid_search and declines transport errors", async () => {
  const bad = vi.fn(async (input: string | URL | Request) =>
    String(input).endsWith("/api/list")
      ? Response.json(listed())
      : Response.json({ Error: "invalid regexp" }, { status: 400 }),
  ) as typeof fetch;
  await expect(
    zoektBackend({ url: "http://127.0.0.1/", fetch: bad }).search(request(), async () => true),
  ).rejects.toMatchObject({ code: "VALIDATION", details: { reason: "invalid_search" } });
  const malformed = vi.fn(async (input: string | URL | Request) =>
    String(input).endsWith("/api/list")
      ? Response.json(listed())
      : new Response("", { status: 400 }),
  ) as typeof fetch;
  expect(
    await zoektBackend({ url: "http://127.0.0.1/", fetch: malformed }).search(
      request(),
      async () => true,
    ),
  ).toBeNull();
  const down = vi.fn(async () => {
    throw new Error("offline");
  }) as typeof fetch;
  expect(
    await zoektBackend({ url: "http://127.0.0.1/", fetch: down }).search(
      request(),
      async () => true,
    ),
  ).toBeNull();
});
