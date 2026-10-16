import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";
import { initRoomRepo } from "./repo.js";
import { materialize } from "./materialize.js";
import { PARSE_APPLY_BUDGET_BYTES, PARSE_FILE_MAX_BYTES, parseConflicts } from "./parse-check.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crossover-parse-check-"));
  roots.push(root);
  const repo = await initRoomRepo(root, "room_parse");
  const options = { gitDir: repo, timeoutMs: 5000 };
  const empty = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
  const base = await materialize(repo, empty, [
    { type: "create", path: "src/main.ts", content: "const value = 0;\n" },
    { type: "create", path: "src/main.js", content: "const value = 0;\n" },
    { type: "create", path: "src/main.tsx", content: "const value = <div />;\n" },
    { type: "create", path: "src/main.py", content: "value = 0\n" },
  ]);
  return { repo, options, base };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parseConflicts", () => {
  it.each([
    ["src/main.ts", "const value = ;\n"],
    ["src/main.js", "const value = ;\n"],
    ["src/main.tsx", "const value = <div>\n"],
    ["src/main.py", "def broken(:\n    pass\n"],
  ])("uses the language grammar for %s", async (path, malformed) => {
    const f = await fixture();
    const head = f.base;
    const candidate = f.base;
    const broken = await materialize(f.repo, head, [{ type: "modify", path, content: malformed }]);
    const tree = (await git(["rev-parse", `${broken}^{tree}`], f.options)).stdout.trim();

    await expect(parseConflicts(f.repo, head, candidate, { clean: true, tree })).resolves.toEqual([
      path,
    ]);
  });

  // Measured (T1529): idle 1391 ms, 3x load 3028 ms; budget 7x.
  it("rejects syntax broken by the merged tree when both input versions parse", async () => {
    const f = await fixture();
    const head = await materialize(f.repo, f.base, [
      { type: "modify", path: "src/main.ts", content: "const value = 1;\n" },
    ]);
    const candidate = await materialize(f.repo, f.base, [
      { type: "modify", path: "src/main.ts", content: "const value = 2;\n" },
    ]);
    const malformedTree = await materialize(f.repo, head, [
      { type: "modify", path: "src/main.ts", content: "const value = ;\n" },
    ]);
    const tree = (await git(["rev-parse", `${malformedTree}^{tree}`], f.options)).stdout.trim();

    await expect(parseConflicts(f.repo, head, candidate, { clean: true, tree })).resolves.toEqual([
      "src/main.ts",
    ]);
  }, 25_000);

  // Measured (T1529): idle 770 ms, 3x load 2048 ms; budget 7x.
  it("allows a candidate source file that was already syntactically invalid", async () => {
    const f = await fixture();
    const head = await materialize(f.repo, f.base, [
      { type: "modify", path: "src/main.ts", content: "const value = 1;\n" },
    ]);
    const candidate = await materialize(f.repo, f.base, [
      { type: "modify", path: "src/main.ts", content: "const value = ;\n" },
    ]);
    const tree = (await git(["rev-parse", `${candidate}^{tree}`], f.options)).stdout.trim();

    await expect(parseConflicts(f.repo, head, candidate, { clean: true, tree })).resolves.toEqual(
      [],
    );
  }, 15_000);

  // Measured (T1529): idle 1026 ms, 3x load 3313 ms; budget 7x.
  it("checks a newly added file whose missing head version is valid", async () => {
    const f = await fixture();
    const head = f.base;
    const candidate = await materialize(f.repo, f.base, [
      { type: "create", path: "src/new.py", content: "value = 1\n" },
    ]);
    const malformed = await materialize(f.repo, candidate, [
      { type: "modify", path: "src/new.py", content: "def broken(:\n" },
    ]);
    const tree = (await git(["rev-parse", `${malformed}^{tree}`], f.options)).stdout.trim();

    await expect(parseConflicts(f.repo, head, candidate, { clean: true, tree })).resolves.toEqual([
      "src/new.py",
    ]);
  }, 25_000);

  it("uses TSX only for .tsx files, while JSX is a .ts syntax error", async () => {
    const f = await fixture();
    const malformed = await materialize(f.repo, f.base, [
      { type: "modify", path: "src/main.tsx", content: "const view = <span />;\n" },
      { type: "modify", path: "src/main.ts", content: "const view = <div />;\n" },
    ]);
    const tree = (await git(["rev-parse", `${malformed}^{tree}`], f.options)).stdout.trim();

    await expect(parseConflicts(f.repo, f.base, f.base, { clean: true, tree })).resolves.toEqual([
      "src/main.ts",
    ]);
  });

  it.each([
    ["semicolon-separated statements", "a = 1; b = 2\n"],
    ["an indented top-level comment", "x = 1\n    # c\n"],
  ])("allows valid Python with %s", async (_name, source) => {
    const f = await fixture();
    const valid = await materialize(f.repo, f.base, [
      { type: "modify", path: "src/main.py", content: source },
    ]);
    const tree = (await git(["rev-parse", `${valid}^{tree}`], f.options)).stdout.trim();

    await expect(parseConflicts(f.repo, f.base, f.base, { clean: true, tree })).resolves.toEqual(
      [],
    );
  });

  it("skips a source file version above the per-file byte cap", async () => {
    const f = await fixture();
    const tooLarge = `def broken(:\n#${"x".repeat(PARSE_FILE_MAX_BYTES)}\n`;
    const malformed = await materialize(f.repo, f.base, [
      { type: "modify", path: "src/main.py", content: tooLarge },
    ]);
    const tree = (await git(["rev-parse", `${malformed}^{tree}`], f.options)).stdout.trim();

    await expect(parseConflicts(f.repo, f.base, f.base, { clean: true, tree })).resolves.toEqual(
      [],
    );
  });

  // Measured (T1529): idle 2035 ms, 3x load 4765 ms; budget 7x.
  it("stops scheduling files when the per-apply byte budget is exhausted", async () => {
    const f = await fixture();
    const padding = "x".repeat(900_000);
    const paths = Array.from({ length: 5 }, (_, index) => `src/budget-${index}.py`);
    const base = await materialize(
      f.repo,
      f.base,
      paths.map((path, index) => ({
        type: "create" as const,
        path,
        content: `value_${index} = ${index}\n#${index}${padding}\n`,
      })),
    );
    const malformed = await materialize(
      f.repo,
      base,
      paths.map((path, index) => ({
        type: "modify" as const,
        path,
        content: `def broken_${index}(:\n#${index}${padding}\n`,
      })),
    );
    const tree = (await git(["rev-parse", `${malformed}^{tree}`], f.options)).stdout.trim();
    expect(PARSE_APPLY_BUDGET_BYTES).toBe(8 * 1024 * 1024);

    const conflicts = await parseConflicts(f.repo, base, base, { clean: true, tree });
    expect(conflicts).toHaveLength(4);
    expect(conflicts).not.toContain(paths[4]);
  }, 35_000);

  // Measured (T1529): idle 1424 ms, 3x load 2526 ms; budget 7x.
  it("ignores files outside the supported source grammars", async () => {
    const f = await fixture();
    const head = await materialize(f.repo, f.base, [
      { type: "create", path: "notes.txt", content: "base\n" },
    ]);
    const candidate = await materialize(f.repo, f.base, [
      { type: "create", path: "notes.txt", content: "candidate\n" },
    ]);
    const malformedTree = await materialize(f.repo, head, [
      { type: "modify", path: "notes.txt", content: "not source syntax\n" },
    ]);
    const tree = (await git(["rev-parse", `${malformedTree}^{tree}`], f.options)).stdout.trim();

    await expect(parseConflicts(f.repo, head, candidate, { clean: true, tree })).resolves.toEqual(
      [],
    );
  }, 20_000);
});
