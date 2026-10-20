import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "@crossover/db";
import { describe, expect, it } from "vitest";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { initRoomRepo } from "./repo.js";
import { ripgrepBackend, type SearchMatch, type SearchRequest } from "./search-backend.js";
import { ZoektIndexer } from "./zoekt-index.js";
import { zoektBackend } from "./zoekt-search.js";

const image = "crossover-zoekt:test";
let imageAvailable = false;
try {
  execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 1_000 });
  imageAvailable = true;
} catch {
  /* CI builds the image before running tests. */
}

async function addSymlink(repo: string, parent: string, root: string): Promise<string> {
  const env = { GIT_INDEX_FILE: join(root, "link-index") };
  await git(["read-tree", parent], { gitDir: repo, timeoutMs: 10_000, env });
  const oid = (
    await git(["hash-object", "-w", "--stdin"], {
      gitDir: repo,
      timeoutMs: 10_000,
      input: "src/a.txt",
    })
  ).stdout.trim();
  await git(["update-index", "--add", "--cacheinfo", `120000,${oid},link.txt`], {
    gitDir: repo,
    timeoutMs: 10_000,
    env,
  });
  const tree = (await git(["write-tree"], { gitDir: repo, timeoutMs: 10_000, env })).stdout.trim();
  return (
    await git(["commit-tree", tree, "-p", parent, "-m", "symlink"], {
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
}

describe.skipIf(!imageAvailable && !process.env["CI"])("Zoekt search parity", () => {
  it("matches ripgrep and keeps rooms isolated; serves only the DB head", async () => {
    const root = await mkdtemp(join(tmpdir(), "zoekt-parity-"));
    const indexDir = join(root, "index");
    const container = `crossover-zoekt-parity-${process.pid}`;
    let started = false;
    try {
      await chmod(root, 0o755);
      await mkdir(indexDir, { mode: 0o777 });
      await chmod(indexDir, 0o777);
      const repo = await initRoomRepo(root, "room_A");
      const otherRepo = await initRoomRepo(root, "room_B");
      const base = (
        await git(["rev-parse", "refs/room/canonical"], {
          gitDir: repo,
          timeoutMs: 10_000,
        })
      ).stdout.trim();
      const entries = Array.from({ length: 30 }, (_, i) => ({
        type: "create" as const,
        path: `filler/f${String(i).padStart(2, "0")}.txt`,
        content: `filler ${i}\n`,
      }));
      const regular = await materialize(repo, base, [
        ...entries,
        {
          type: "create",
          path: "src/a.txt",
          content: 'needle1\na.b(c)\na"b\nfooobar\nNEEDLE\ncafé\n',
        },
        { type: "create", path: "src/deep/test.ts", content: "needle2\n" },
        { type: "create", path: "docs/readme.md", content: "needle3\n" },
        { type: "create", path: "a.txt", content: "needle4\r\n" },
        { type: "create", path: "b.txt", content: "needle5\n" },
        { type: "create", path: "big.txt", content: `${"x".repeat(1024 * 1024)} needle6\n` },
        { type: "create", path: "binary.bin", content: "\0needle7\n" },
        { type: "create", path: "src/c.txt", content: "unrelated\n" },
        { type: "create", path: "docs/other.md", content: "unrelated\n" },
      ]);
      const commit = await addSymlink(repo, regular, root);
      const otherBase = (
        await git(["rev-parse", "refs/room/canonical"], {
          gitDir: otherRepo,
          timeoutMs: 10_000,
        })
      ).stdout.trim();
      const otherCommit = await materialize(otherRepo, otherBase, [
        { type: "create", path: "src/a.txt", content: "other-room-secret\n" },
      ]);
      const pool = {
        query: async (sql: string, params: unknown[]) => ({
          rows: sql.includes("SELECT w.repo_path")
            ? [
                {
                  repo_path: params[0] === "room_B" ? otherRepo : repo,
                  commit_sha: params[0] === "room_B" ? otherCommit : commit,
                  revision: "1",
                  status: "ACTIVE",
                  purge_started_at: null,
                },
              ]
            : [{ revision: "1", purge_started_at: null }],
        }),
      } as unknown as Pool;
      const indexer = new ZoektIndexer({
        pool,
        indexDir,
        concurrency: 1,
        timeoutMs: 60_000,
        command: [
          "docker",
          "run",
          "--rm",
          "--entrypoint",
          "zoekt-git-index",
          "-v",
          `${root}:${root}:ro`,
          "-v",
          `${indexDir}:${indexDir}`,
          image,
        ],
      });
      expect(await indexer.index("room_A", 1, new AbortController().signal)).toBe("indexed");
      expect(await indexer.index("room_B", 1, new AbortController().signal)).toBe("indexed");
      await indexer.close();
      execFileSync(
        "docker",
        [
          "run",
          "-d",
          "--name",
          container,
          "-p",
          "127.0.0.1::6070",
          "-v",
          `${indexDir}:/data/index:ro`,
          image,
        ],
        { stdio: "ignore", timeout: 10_000 },
      );
      started = true;
      const mapping = execFileSync("docker", ["port", container, "6070/tcp"], { encoding: "utf8" });
      const url = `http://127.0.0.1:${Number(mapping.trim().split(":").at(-1))}/`;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const response = await fetch(new URL("api/list", url), {
            method: "POST",
            body: JSON.stringify({ Q: "repo:^room_A$" }),
          });
          if (response.ok) break;
        } catch {
          /* sidecar starting */
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const zoekt = zoektBackend({ url });
      await expect(
        zoekt.search(
          {
            room_id: "room_A",
            repo_path: repo,
            commit,
            revision: 1,
            is_head: true,
            query: "(",
            regex: true,
            case_sensitive: true,
          },
          async () => true,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION", details: { reason: "invalid_search" } });
      const cases: Array<Pick<SearchRequest, "query" | "regex" | "case_sensitive" | "glob">> = [
        { query: "needle", regex: false, case_sensitive: true },
        { query: "a.b(c)", regex: false, case_sensitive: true },
        { query: 'a"b', regex: false, case_sensitive: true },
        { query: "fo+bar", regex: true, case_sensitive: true },
        { query: "NEEDLE", regex: false, case_sensitive: false },
        { query: "needle", regex: false, case_sensitive: true, glob: "*.md" },
        { query: "needle", regex: false, case_sensitive: true, glob: "docs/**" },
        { query: "needle", regex: false, case_sensitive: true, glob: "src/**/test.ts" },
        { query: "needle", regex: false, case_sensitive: true, glob: "?.txt" },
        { query: "café", regex: false, case_sensitive: true },
        { query: "missing", regex: false, case_sensitive: true },
      ];
      const baseRequest: SearchRequest = {
        room_id: "room_A",
        repo_path: repo,
        commit,
        revision: 1,
        is_head: true,
        query: "",
        regex: false,
        case_sensitive: true,
      };
      for (const params of cases) {
        const request = { ...baseRequest, ...params };
        const indexed: SearchMatch[] = [];
        const scanned: SearchMatch[] = [];
        const result = await zoekt.search(request, async (match) => {
          indexed.push(match);
          return true;
        });
        expect(result, JSON.stringify(params)).not.toBeNull();
        await ripgrepBackend.search(request, async (match) => {
          scanned.push(match);
          return true;
        });
        const order = (a: SearchMatch, b: SearchMatch) =>
          a.path.localeCompare(b.path) || a.line - b.line;
        expect(indexed.sort(order), JSON.stringify(params)).toEqual(scanned.sort(order));
      }
      for (const query of ["^needle\\d+$", "^\\w+$"]) {
        const incompatible = { ...baseRequest, query, regex: true };
        expect(await zoekt.search(incompatible, async () => true)).toBeNull();
        const scanned: SearchMatch[] = [];
        expect(
          await ripgrepBackend.search(incompatible, async (match) => {
            scanned.push(match);
            return true;
          }),
        ).not.toBeNull();
        expect(scanned.length).toBeGreaterThan(0);
        if (query === "^\\w+$") {
          expect(scanned).toContainEqual({ path: "src/a.txt", line: 6, text: "café" });
        }
      }
      for (const query of ["(a)\\1", "a(?=b)"]) {
        const incompatible = { ...baseRequest, query, regex: true };
        expect(await zoekt.search(incompatible, async () => true)).toBeNull();
        await expect(ripgrepBackend.search(incompatible, async () => true)).rejects.toMatchObject({
          code: "VALIDATION",
          details: { reason: "invalid_search" },
        });
      }
      const isolated: SearchMatch[] = [];
      expect(
        await zoekt.search({ ...baseRequest, query: "other-room-secret" }, async (match) => {
          isolated.push(match);
          return true;
        }),
      ).toEqual({ truncated: false });
      expect(isolated).toEqual([]);
      const newer = await materialize(repo, commit, [
        { type: "create", path: "new.txt", content: "fresh needle\n" },
      ]);
      const freshRequest = { ...baseRequest, commit: newer, query: "fresh" };
      expect(await zoekt.search(freshRequest, async () => true)).toBeNull();
      const fallback: SearchMatch[] = [];
      await ripgrepBackend.search(freshRequest, async (match) => {
        fallback.push(match);
        return true;
      });
      expect(fallback).toEqual([{ path: "new.txt", line: 1, text: "fresh needle" }]);
    } finally {
      if (started) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
