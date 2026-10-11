import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as gitModule from "./git.js";
import { git } from "./git.js";
import { materialize } from "./materialize.js";
import { initRoomRepo } from "./repo.js";
import { assessCircuitBreaker } from "./circuit-breaker.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("skips the baseline scan when a ChangeSet removes fewer than 60 text lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "crossover-circuit-breaker-"));
  roots.push(root);
  const repoPath = await initRoomRepo(root, "room_test");
  const options = { gitDir: repoPath, timeoutMs: 10_000 };
  const baseCommit = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
  const base = await materialize(repoPath, baseCommit, [
    { type: "create", path: "small.txt", content: "one\ntwo\nthree\n" },
  ]);
  const candidate = await materialize(repoPath, base, [{ type: "delete", path: "small.txt" }]);
  const spy = vi.spyOn(gitModule, "git");

  const assessment = await assessCircuitBreaker({
    repoPath,
    baseCommit: base,
    candidateTree: candidate,
    touchedPaths: ["small.txt"],
    protectedPatterns: [],
    rejectedRecently: false,
  });

  expect(spy.mock.calls.some(([args]) => args.includes("grep"))).toBe(false);
  expect(assessment.reasons).not.toContain("lines_removed");
});

it("caches a base tree's line count across ChangeSets", async () => {
  const root = await mkdtemp(join(tmpdir(), "crossover-circuit-breaker-cache-"));
  roots.push(root);
  const repoPath = await initRoomRepo(root, "room_test");
  const options = { gitDir: repoPath, timeoutMs: 10_000 };
  const empty = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index}`);
  const base = await materialize(repoPath, empty, [
    { type: "create", path: "large.txt", content: `${lines.join("\n")}\n` },
  ]);
  const firstCandidate = await materialize(repoPath, base, [
    { type: "modify", path: "large.txt", content: `${lines.slice(0, 139).join("\n")}\n` },
  ]);
  const secondCandidate = await materialize(repoPath, base, [
    {
      type: "modify",
      path: "large.txt",
      content: `${[...lines.slice(0, 138), lines.at(-1)!].join("\n")}\n`,
    },
  ]);
  const spy = vi.spyOn(gitModule, "git");
  const assess = (candidateTree: string) =>
    assessCircuitBreaker({
      repoPath,
      baseCommit: base,
      candidateTree,
      touchedPaths: ["large.txt"],
      protectedPatterns: [],
      rejectedRecently: false,
    });

  const first = await assess(firstCandidate);
  const second = await assess(secondCandidate);

  expect(first.reasons).toContain("lines_removed");
  expect(second.reasons).toContain("lines_removed");
  expect(spy.mock.calls.filter(([args]) => args[0] === "grep")).toHaveLength(1);
});
