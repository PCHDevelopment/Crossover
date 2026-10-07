import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as database from "@crossover/db";
import { createTestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { expect, it, vi } from "vitest";
import { registerWorkspaceCommands } from "./apply.js";
import * as materializer from "./materialize.js";
import * as merger from "./merge.js";
import * as binary from "./binary.js";
import * as treeChanges from "./tree-changes.js";
import * as classifier from "./conflicts.js";
import * as gitModule from "./git.js";
import { git } from "./git.js";
import { provisionWorkspace } from "./provision.js";
import { updateCanonicalRef } from "./reconcile.js";
import { refreshSearchTree } from "./search-tree.js";
import type { Operation } from "./operations.js";

type Sample = Record<string, number>;
type ActiveSample = {
  timings: Sample;
  gitInvocations: Record<string, number>;
  currentStage?: string;
};
let active: ActiveSample | undefined;
async function timed<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const sample = active;
  const previous = sample?.currentStage;
  if (sample) sample.currentStage = stage;
  const start = performance.now();
  try {
    return await work();
  } finally {
    if (sample) {
      sample.timings[stage] = (sample.timings[stage] ?? 0) + performance.now() - start;
      if (previous === undefined) delete sample.currentStage;
      else sample.currentStage = previous;
    }
  }
}
function instrument() {
  const runGit = gitModule.git;
  vi.spyOn(gitModule, "git").mockImplementation((...args) => {
    if (active?.currentStage) {
      const key = `${active.currentStage}_git_invocations`;
      active.gitInvocations[key] = (active.gitInvocations[key] ?? 0) + 1;
    }
    return runGit(...args);
  });
  const materialize = materializer.materialize;
  vi.spyOn(materializer, "materialize").mockImplementation((...args) =>
    timed("materialize", () => materialize(...args)),
  );
  const merge = merger.merge;
  vi.spyOn(merger, "merge").mockImplementation((...args) => {
    if (active) expect(args[1]).not.toBe(args[2]); // Every measured merge has an advanced head.
    return timed("merge", () => merge(...args));
  });
  const check = binary.concurrentBinaryFiles;
  vi.spyOn(binary, "concurrentBinaryFiles").mockImplementation((...args) =>
    timed("binary_check", () => check(...args)),
  );
  const changes = treeChanges.treeChanges;
  vi.spyOn(treeChanges, "treeChanges").mockImplementation((...args) =>
    timed("classify_tree_changes", () => changes(...args)),
  );
  const classify = classifier.classifyConflicts;
  vi.spyOn(classifier, "classifyConflicts").mockImplementation((...args) =>
    timed("classify_tree_changes", () => classify(...args)),
  );
  const transaction = database.withTransaction;
  vi.spyOn(database, "withTransaction").mockImplementation(
    <T>(pool: database.Pool, fn: (client: database.PoolClient) => Promise<T>) =>
      timed("db_transaction_inclusive", () => transaction(pool, fn)),
  );
}
function summary(samples: Sample[]) {
  return Object.fromEntries(
    Object.keys(samples[0]!)
      .sort()
      .map((stage) => {
        const values = samples.map((sample) => sample[stage]!).sort((a, b) => a - b);
        const percentile = (p: number) =>
          Number(values[Math.ceil(values.length * p) - 1]!.toFixed(3));
        return [stage, { p50_ms: percentile(0.5), p95_ms: percentile(0.95) }];
      }),
  );
}

it("profiles 200 clean stale-base applies of 20 files at two repository sizes", async () => {
  const iterations = Number(process.env["BENCH_ITERATIONS"] ?? 200);
  expect(Number.isSafeInteger(iterations) && iterations > 0).toBe(true);
  const db = await createTestDatabase();
  const root = await mkdtemp(join(tmpdir(), "crossover-bench-"));
  const reports = [];
  instrument();
  try {
    for (const files of [40, 10_000]) {
      const room = newId("room");
      await db.pool.query(
        "INSERT INTO rooms (id,slug,name,objective,owner_id) VALUES ($1,$1,'Bench','Profile','actor')",
        [room],
      );
      const workspace = await database.withTransaction(db.pool, (client) =>
        provisionWorkspace(client, room, root),
      );
      const repo = (
        await db.pool.query("SELECT repo_path FROM workspaces WHERE room_id = $1", [room])
      ).rows[0].repo_path as string;
      const options = { gitDir: repo, timeoutMs: 10_000 };
      const content = (head: number, candidate: number, path = "") =>
        `head: ${head}\n` +
        `file: ${path}\n` +
        Array.from({ length: 20 }, (_, index) => `unchanged line ${index}\n`).join("") +
        `candidate: ${candidate}\n`;
      const paths = Array.from(
        { length: files },
        (_, index) => `file${String(index).padStart(5, "0")}.txt`,
      );
      const blob = (
        await git(["hash-object", "-w", "--stdin"], { ...options, input: content(-1, -1) })
      ).stdout.trim();
      const editableBlobs = new Map(
        await Promise.all(
          paths.slice(0, 20).map(
            async (path) =>
              [
                path,
                (
                  await git(["hash-object", "-w", "--stdin"], {
                    ...options,
                    input: content(-1, -1, path),
                  })
                ).stdout.trim(),
              ] as const,
          ),
        ),
      );
      const tree = (
        await git(["mktree", "-z"], {
          ...options,
          input: paths
            .map((path) => `100644 blob ${editableBlobs.get(path) ?? blob}\t${path}\0`)
            .join(""),
        })
      ).stdout.trim();
      const initial = (await git(["rev-parse", "refs/room/canonical"], options)).stdout.trim();
      const seed = (
        await git(["commit-tree", tree, "-p", initial], {
          ...options,
          input: "Bench seed\n",
          env: {
            GIT_AUTHOR_NAME: "Bench",
            GIT_AUTHOR_EMAIL: "bench@example.test",
            GIT_COMMITTER_NAME: "Bench",
            GIT_COMMITTER_EMAIL: "bench@example.test",
          },
        })
      ).stdout.trim();
      await db.pool.query(
        "UPDATE workspace_revisions SET commit_sha=$3 WHERE room_id=$1 AND workspace_id=$2 AND revision=0",
        [room, workspace, seed],
      );
      await updateCanonicalRef(repo, seed, initial);
      const failures: unknown[] = [];
      const dispatcher = new Dispatcher({
        pool: db.pool,
        authorize: allowAll,
        nodeId: room,
        onAfterCommitError: (error) => {
          failures.push(error);
        },
      });
      registerWorkspaceCommands(dispatcher, {
        updateCanonicalRef: (...args) => timed("after_commit", () => updateCanonicalRef(...args)),
        refreshSearchTree: (repo, commit, previousCommit) =>
          timed("after_commit", () => refreshSearchTree(repo, commit, previousCommit)),
      });
      const principal = {
        room_id: room,
        participant_id: "actor",
        kind: "HUMAN" as const,
        authority: "OWNER" as const,
        role: "LEAD" as const,
      };
      const apply = (base: number, head: number, candidate: number) =>
        dispatcher.dispatch(principal, {
          id: newId("cmd"),
          method: "workspace.apply_changeset",
          idempotency_key: newId("cmd"),
          params: {
            source: "API",
            message: "Bench",
            base_workspace_revision: base,
            operations: paths.slice(0, 20).map((path): Operation => ({
              type: "modify",
              path,
              content: content(head, candidate, path),
            })),
          },
        });
      const samples: { timings: Sample; gitInvocations: Record<string, number> }[] = [];
      for (let index = 0; index < iterations; index++) {
        expect((await apply(index * 2, index, index - 1)).response).toMatchObject({
          status: "APPLIED",
          applied_revision: index * 2 + 1,
        });
        active = {
          timings: {
            total_apply: 0,
            materialize: 0,
            merge: 0,
            binary_check: 0,
            classify_tree_changes: 0,
            db_transaction_inclusive: 0,
            after_commit: 0,
          },
          gitInvocations: {},
        };
        const result = await timed("total_apply", () => apply(index * 2, index - 1, index));
        expect(result.response).toMatchObject({
          status: "APPLIED",
          applied_revision: index * 2 + 2,
        });
        expect(failures).toEqual([]);
        for (const stage of Object.keys(active.timings))
          expect(active.timings[stage]).toBeGreaterThan(0);
        active.timings["db_transaction_other"] = Math.max(
          0,
          active.timings["db_transaction_inclusive"]! -
            active.timings["materialize"]! -
            active.timings["merge"]! -
            active.timings["classify_tree_changes"]!,
        );
        samples.push({ timings: active.timings, gitInvocations: active.gitInvocations });
        active = undefined;
        if ((index + 1) % 20 === 0)
          process.stdout.write(`Benchmark ${files} files: ${index + 1}/${iterations}\n`);
      }
      for (const path of paths.slice(0, 20)) {
        const read = await dispatcher.dispatch(principal, {
          id: newId("cmd"),
          method: "workspace.read",
          params: { path },
        });
        expect(read.response).toMatchObject({
          content: content(iterations - 1, iterations - 1, path),
        });
        expect(await readFile(join(`${repo}.search`, "tree", path), "utf8")).toBe(
          content(iterations - 1, iterations - 1, path),
        );
      }
      const stages = summary(samples.map((sample) => sample.timings));
      const git_invocations = Object.fromEntries(
        Object.keys(samples[0]!.gitInvocations)
          .sort()
          .map((stage) => {
            const values = samples
              .map((sample) => sample.gitInvocations[stage]!)
              .sort((a, b) => a - b);
            return [
              stage.replace(/_git_invocations$/, ""),
              {
                per_apply: values[0],
                mean_calls: Number(
                  (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2),
                ),
              },
            ];
          }),
      );
      reports.push({
        files,
        iterations,
        edited_files: 20,
        stages,
        git_invocations,
        targets: {
          merge_p95_ms: 50,
          total_apply_p95_ms: 500,
          merge_met: stages["merge"]!.p95_ms < 50,
          total_apply_met: stages["total_apply"]!.p95_ms < 500,
        },
      });
      process.stdout.write(`${JSON.stringify(reports.at(-1), null, 2)}\n`);
    }
    const report = {
      node: process.version,
      platform: process.platform,
      cpu: cpus()[0]?.model,
      workload:
        "Full-content modifications of the same 20 paths on both sides, on separated lines. Setup/head advancement is excluded; no patches or introduced paths.",
      timing:
        "Nested/inclusive wall-clock stages; db_transaction_other subtracts materialize, merge and treeChanges. Binary check is inside merge. Percentiles are nearest rank.",
      reports,
    };
    if (process.env["BENCH_OUTPUT"])
      await writeFile(process.env["BENCH_OUTPUT"], JSON.stringify(report, null, 2));
  } finally {
    active = undefined;
    vi.restoreAllMocks();
    await db.drop();
    await rm(root, { recursive: true, force: true });
  }
});
