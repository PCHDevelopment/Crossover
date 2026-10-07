import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.js";
import { initRoomRepo } from "./repo.js";
import { materialize } from "./materialize.js";
import { parseConflicts } from "./parse-check.js";

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
  });

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
  });

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
  });
});
