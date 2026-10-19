import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { globToRegExpSource } from "./search-glob.js";
import { runSearch } from "./search-runner.js";

let root: string;
const paths = [
  "a.txt",
  "b.txt",
  "d/a.txt",
  "d/sub/c.txt",
  "e/a.md",
  "x/e/b.md",
  "docs/index.md",
  "docs/deep/a.md",
  "src/test.ts",
  "src/a/test.ts",
  "src/a/deep/test.ts",
];

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
  ["*.txt", ["a.txt", "b.txt", "d/a.txt", "d/sub/c.txt"]],
  ["d/*.txt", ["d/a.txt"]],
  ["/a.txt", ["a.txt"]],
  ["**/e/*.md", ["e/a.md", "x/e/b.md"]],
  ["docs/**", ["docs/index.md", "docs/deep/a.md"]],
  ["?.txt", ["a.txt", "b.txt", "d/a.txt", "d/sub/c.txt"]],
  ["src/**/test.ts", ["src/test.ts", "src/a/test.ts", "src/a/deep/test.ts"]],
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
  expect(actual.sort()).toEqual(expected.sort());
});

it("declines unsupported gitignore glob constructs", () => {
  for (const glob of ["[a].txt", "{a,b}.txt", "\\a.txt", "!a.txt", "x/a**b.txt"])
    expect(globToRegExpSource(glob)).toBeNull();
});
