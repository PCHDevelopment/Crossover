import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { globMatchesPath, globToRegExpSource } from "./search-glob.js";
import { runSearch } from "./search-runner.js";

let root: string;
const paths = ["a.txt", "d/a.txt", "d/e/b.md", "docs/x.md", "src/t/test.ts"];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "crossover-search-glob-"));
  for (const path of paths) {
    const file = join(root, path);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "needle\n");
  }
});
afterAll(async () => rm(root, { recursive: true, force: true }));

it.each([
  ["*.txt", ["a.txt", "d/a.txt"]],
  ["d/*.txt", ["d/a.txt"]],
  ["/a.txt", ["a.txt"]],
  ["**/e/*.md", ["d/e/b.md"]],
  ["docs/**", ["docs/x.md"]],
  ["?.txt", ["a.txt", "d/a.txt"]],
  ["src/**/test.ts", ["src/t/test.ts"]],
])("matches ripgrep path semantics for %s", async (glob, expected) => {
  const actual: string[] = [];
  await runSearch(
    root,
    { query: "needle", regex: false, case_sensitive: true, glob },
    async (match) => {
      actual.push(match.path);
      return true;
    },
  );
  const source = globToRegExpSource(glob);
  expect(source).not.toBeNull();
  const matcher = new RegExp(source!);
  expect(paths.filter((path) => matcher.test(path)).sort()).toEqual(expected.sort());
  expect(paths.filter((path) => globMatchesPath(glob, path)).sort()).toEqual(expected.sort());
  expect(actual.sort()).toEqual(expected.sort());
});

it("bounds matching for repeated wildcard terms", () => {
  const glob = `${"*a".repeat(80)}b`;
  expect(globMatchesPath(glob, "a".repeat(256))).toBe(false);
  expect(globMatchesPath(glob, `${"a".repeat(80)}b`)).toBe(true);
});

it("declines unsupported gitignore glob constructs", () => {
  for (const glob of ["[a].txt", "{a,b}.txt", "\\a.txt", "!a.txt", "x/a**b.txt"])
    expect(globToRegExpSource(glob)).toBeNull();
});
