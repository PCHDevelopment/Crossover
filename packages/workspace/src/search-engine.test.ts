import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { initRoomRepo } from "./repo.js";
import { runSearch, type SearchMatch } from "./search-runner.js";
import { withSearchTree } from "./search-tree.js";

it("serializes cache refreshes with readers, replaces deleted files and repairs missing cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "crossover-search-tree-"));
  try {
    const repo = await initRoomRepo(root, "room_test");
    const initial = (
      await git(["rev-parse", "refs/room/canonical"], {
        gitDir: repo,
        timeoutMs: 10_000,
      })
    ).stdout.trim();
    const first = await materialize(repo, initial, [
      { type: "create", path: "old", content: "one" },
    ]);
    const second = await materialize(repo, first, [
      { type: "delete", path: "old" },
      { type: "create", path: "new", content: "two" },
    ]);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = withSearchTree(repo, first, async (tree) => {
      entered();
      await gate;
      expect(await readFile(join(tree, "old"), "utf8")).toBe("one");
    });
    await started;
    const writer = withSearchTree(repo, second, async (tree) => {
      expect(await readFile(join(tree, "new"), "utf8")).toBe("two");
      await expect(stat(join(tree, "old"))).rejects.toMatchObject({ code: "ENOENT" });
    });
    release();
    await Promise.all([reader, writer]);
    await rm(join(`${repo}.search`, "tree"), { recursive: true });
    await withSearchTree(repo, second, async (tree) => {
      expect(await readFile(join(tree, "new"), "utf8")).toBe("two");
    });
    await expect(
      withSearchTree(repo, first, async () => {
        throw new Error("Reader failed");
      }),
    ).rejects.toThrow("Reader failed");
    await withSearchTree(repo, second, async () => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("streams literal/regex/case/glob results, skips symlinks/binaries, bounds matches and rejects bad queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "crossover-search-runner-"));
  try {
    const { writeFile, symlink } = await import("node:fs/promises");
    await writeFile(join(root, "a[1].txt"), "literal.*\nLITERAL.*\nother\n");
    await writeFile(join(root, ".hidden"), "literal.*\n");
    await writeFile(join(root, "binary"), "literal.*\0binary");
    await symlink("a[1].txt", join(root, "link"));
    const options = { query: "literal.*", regex: false, case_sensitive: true };
    const collect = async (params = options) => {
      const matches: SearchMatch[] = [];
      const result = await runSearch(root, params, async (match) => {
        matches.push(match);
        return true;
      });
      return { matches, ...result };
    };
    const literal = await collect();
    expect(literal.matches.map((match) => match.path).sort()).toEqual([".hidden", "a[1].txt"]);
    expect((await collect({ ...options, case_sensitive: false })).matches).toHaveLength(3);
    expect((await collect({ ...options, query: "^other$", regex: true })).matches).toEqual([
      { path: "a[1].txt", line: 3, text: "other" },
    ]);
    expect((await collect({ ...options, query: "no match" })).matches).toEqual([]);
    const glob: SearchMatch[] = [];
    await runSearch(root, { ...options, glob: "*.txt" }, async (match) => {
      glob.push(match);
      return true;
    });
    expect(glob).toEqual([{ path: "a[1].txt", line: 1, text: "literal.*" }]);
    expect(await runSearch(root, options, async () => false)).toEqual({ truncated: true });
    await expect(collect({ ...options, query: "[", regex: true })).rejects.toMatchObject({
      code: "VALIDATION",
      details: { reason: "invalid_search" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
