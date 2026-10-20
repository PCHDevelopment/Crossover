import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import * as database from "@crossover/db";
import { createTestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { expect, it } from "vitest";
import { registerWorkspaceCommands } from "./apply.js";
import { git } from "./git.js";
import type { Operation } from "./operations.js";
import { provisionWorkspace } from "./provision.js";
import { updateCanonicalRef } from "./reconcile.js";
import { recordWorkspaceRevision } from "./revision.js";
import { ripgrepBackend, type SearchBackend } from "./search-backend.js";
import { buildSearchFixture } from "./search-bench-fixture.js";
import { refreshSearchTree } from "./search-tree.js";
import { ZoektIndexer } from "./zoekt-index.js";
import { zoektBackend } from "./zoekt-search.js";

const FILES = Number(process.env["BENCH_FILES"] ?? 50_000);
const RUNS = Number(process.env["BENCH_RUNS"] ?? 20);
const FULL = FILES >= 50_000;
const IMAGE = process.env["ZOEKT_IMAGE"] ?? "crossover-zoekt:bench";
const PORT = 16_070;
const MIB = 1024 * 1024;

type Mode = "zoekt" | "ripgrep" | "git_grep";
interface Query {
  query: string;
  regex?: boolean;
  glob?: string;
}

/** Nearest rank, as in workspace.bench.ts. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!.toFixed(3));
}
const stats = (values: number[]) => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: percentile(values, 1),
});

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await directoryBytes(path) : (await stat(path)).size;
  }
  return total;
}

it("measures workspace.search latency, index build and index lag on a 50,000-file repository", async () => {
  const db = await createTestDatabase();
  const root = await mkdtemp(join(tmpdir(), "crossover-search-bench-"));
  const indexDir = join(root, "index");
  const container = `crossover-zoekt-bench-${process.pid}`;
  const url = `http://127.0.0.1:${PORT}/`;
  let indexer: ZoektIndexer | undefined;
  try {
    await chmod(root, 0o755);
    await mkdir(indexDir, { mode: 0o777 });
    await chmod(indexDir, 0o777);
    const room = newId("room");
    await db.pool.query(
      "INSERT INTO rooms (id,slug,name,objective,owner_id) VALUES ($1,$1,'Bench','Search','actor')",
      [room],
    );
    const workspace = await database.withTransaction(db.pool, (client) =>
      provisionWorkspace(client, room, root),
    );
    const repo = (
      await db.pool.query("SELECT repo_path FROM workspaces WHERE room_id = $1", [room])
    ).rows[0].repo_path as string;
    const initial = (
      await git(["rev-parse", "refs/room/canonical"], { gitDir: repo, timeoutMs: 10_000 })
    ).stdout.trim();

    // Revision 1 is the fixture commit on top of the provisioned revision 0.
    const generated = performance.now();
    const fixture = await buildSearchFixture({
      repo,
      parent: initial,
      files: FILES,
      bigBytes: FULL ? MIB : 16_384,
    });
    const generate_ms = performance.now() - generated;
    await database.withTransaction(db.pool, (client) =>
      recordWorkspaceRevision(client, {
        workspace_id: workspace,
        room_id: room,
        revision: 1,
        commit_sha: fixture.commit,
      }),
    );
    await updateCanonicalRef(repo, fixture.commit, initial);
    await refreshSearchTree(repo, fixture.commit);
    if (FULL) {
      expect(fixture.paths.length).toBeGreaterThanOrEqual(50_000);
      expect(Math.abs(fixture.bytes / MIB - 1000)).toBeLessThanOrEqual(20);
    }

    indexer = new ZoektIndexer({
      pool: db.pool,
      indexDir,
      concurrency: 1,
      timeoutMs: 1_800_000,
      command: [
        "docker",
        "run",
        "--rm",
        "-v",
        `${repo}:${repo}:ro`,
        "-v",
        `${indexDir}:${indexDir}`,
        "--entrypoint",
        "zoekt-git-index",
        IMAGE,
      ],
    });
    const built = performance.now();
    expect(await indexer.index(room, 1, new AbortController().signal)).toBe("indexed");
    const index_build_ms = performance.now() - built;
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        container,
        "-p",
        `127.0.0.1:${PORT}:6070`,
        "-v",
        `${indexDir}:/data/index:ro`,
        IMAGE,
      ],
      { stdio: "ignore", timeout: 30_000 },
    );

    const listed = async (commit: string): Promise<boolean> => {
      try {
        const response = await fetch(new URL("api/list", url), {
          method: "POST",
          body: JSON.stringify({ Q: `repo:^${room}$` }),
        });
        if (!response.ok) return false;
        const body = (await response.json()) as {
          List?: { Repos?: { Repository: { Branches: { Version: string }[] } }[] };
        };
        return (
          body.List?.Repos?.some((repoEntry) =>
            repoEntry.Repository.Branches.some((branch) => branch.Version === commit),
          ) ?? false
        );
      } catch {
        return false; // the sidecar is still starting
      }
    };
    const waitListed = async (commit: string, timeoutMs: number): Promise<void> => {
      const deadline = performance.now() + timeoutMs;
      while (!(await listed(commit))) {
        if (performance.now() > deadline) throw new Error(`zoekt never listed ${commit}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    await waitListed(fixture.commit, 120_000);

    let last: string | undefined;
    const failures: unknown[] = [];
    const dispatcherFor = (headBackends: SearchBackend[]) => {
      const dispatcher = new Dispatcher({
        pool: db.pool,
        authorize: allowAll,
        nodeId: room,
        onAfterCommitError: (error) => {
          failures.push(error);
        },
      });
      registerWorkspaceCommands(dispatcher, {
        updateCanonicalRef,
        refreshSearchTree,
        scheduleSearchIndex: (roomId, revision) => indexer!.schedule(roomId, revision),
        searchHeadBackends: headBackends,
        searchOnBackend: (name) => {
          last = name;
        },
      });
      return dispatcher;
    };
    const principal = {
      room_id: room,
      participant_id: "actor",
      kind: "HUMAN" as const,
      authority: "OWNER" as const,
      role: "LEAD" as const,
    };

    const word = fixture.vocabulary;
    const queries: Query[] = [
      ...[0, 2, 4, 6, 8].map((k) => ({ query: `rare_token_${k}` })),
      { query: "common_word" },
      ...[0, 1, 2, 3].map((i) => ({ query: word[i]! })),
      { query: "rare_token_[0-4]($|[^0-9])", regex: true },
      { query: "^  return common_word", regex: true },
      { query: "rare_token_[5-9]", regex: true },
      { query: `${word[0]!}.*${word[1]!}`, regex: true },
      { query: "(rare|common)_(token_1|word)", regex: true },
      ...["docs/**", "*.md", "src/m1*/**", "?.ts", "src/**/f1.ts"].map((glob) => ({
        query: word[0]!,
        glob,
      })),
    ];
    const perQuery: Record<string, unknown>[] = [];
    const runMode = async (mode: Mode, backends: SearchBackend[], revision?: number) => {
      const dispatcher = dispatcherFor(backends);
      const pooled: number[] = [];
      const unserved: string[] = [];
      for (const query of queries) {
        const samples: number[] = [];
        let matches = 0;
        for (let run = 0; run < RUNS; run++) {
          last = undefined;
          const started = performance.now();
          const result = await dispatcher.dispatch(principal, {
            id: newId("cmd"),
            method: "workspace.search",
            params: {
              query: query.query,
              regex: query.regex ?? false,
              case_sensitive: true,
              ...(query.glob === undefined ? {} : { glob: query.glob }),
              ...(revision === undefined ? {} : { revision }),
            },
          });
          samples.push(performance.now() - started);
          matches = (result.response as { matches: unknown[] }).matches.length;
          if (mode === "zoekt" && last !== "zoekt") unserved.push(query.query);
        }
        pooled.push(...samples);
        perQuery.push({ mode, ...query, matches, ...stats(samples) });
      }
      if (mode === "zoekt")
        expect(unserved, "every zoekt-mode run was served by zoekt").toEqual([]);
      process.stdout.write(`Benchmark ${mode}: ${JSON.stringify(stats(pooled))}\n`);
      return stats(pooled);
    };
    const search: Record<Mode, ReturnType<typeof stats>> = {
      zoekt: await runMode("zoekt", [zoektBackend({ url }), ripgrepBackend]),
      ripgrep: await runMode("ripgrep", [ripgrepBackend]),
      git_grep: { p50: 0, p95: 0, max: 0 },
    };

    // Index lag: a 20-file ChangeSet, from the apply response until /api/list reports its commit.
    const lagPaths = fixture.paths.filter((path) => path.startsWith("src/")).slice(0, 20 * 20);
    const applier = dispatcherFor([zoektBackend({ url }), ripgrepBackend]);
    const lag: number[] = [];
    let head = 1;
    for (let index = 0; index < Math.min(20, RUNS); index++) {
      const operations = lagPaths.slice(index * 20, index * 20 + 20).map((path): Operation => ({
        type: "modify",
        path,
        content: `// lag edit ${index}\n${path}\n`,
      }));
      const applied = await applier.dispatch(principal, {
        id: newId("cmd"),
        method: "workspace.apply_changeset",
        idempotency_key: newId("cmd"),
        params: { source: "API", message: "Lag", base_workspace_revision: head, operations },
      });
      expect(applied.response).toMatchObject({ status: "APPLIED", applied_revision: head + 1 });
      const responded = performance.now();
      head++;
      const commit = (
        await db.pool.query(
          "SELECT commit_sha FROM workspace_revisions WHERE room_id = $1 AND revision = $2",
          [room, head],
        )
      ).rows[0].commit_sha as string;
      await waitListed(commit, 300_000);
      lag.push(performance.now() - responded);
    }
    expect(failures).toEqual([]);

    // Revision 1 is no longer the head, so it is served by git grep; this mode runs last.
    search.git_grep = await runMode("git_grep", [ripgrepBackend], 1);

    const report = {
      node: process.version,
      platform: process.platform,
      cpu: cpus()[0]?.model,
      fixture: {
        files: fixture.paths.length,
        bytes: fixture.bytes,
        shard_bytes: await directoryBytes(indexDir),
        repo_bytes: await directoryBytes(repo),
        generate_ms: Math.round(generate_ms),
      },
      runs: RUNS,
      index_build_ms: Math.round(index_build_ms),
      lag_ms: stats(lag),
      search,
      targets: {
        zoekt_p95_ms: 300,
        index_build_ms: 300_000,
        lag_p95_ms: 30_000,
        zoekt_p95_met: search.zoekt.p95 <= 300,
        index_build_met: index_build_ms <= 300_000,
        lag_p95_met: percentile(lag, 0.95) <= 30_000,
      },
      per_query: perQuery,
    };
    process.stdout.write(`${JSON.stringify({ ...report, per_query: undefined }, null, 2)}\n`);
    if (process.env["BENCH_OUTPUT"])
      await writeFile(process.env["BENCH_OUTPUT"], JSON.stringify(report, null, 2));
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 30_000 });
    } catch {
      /* it never started */
    }
    await indexer?.close();
    await db.drop();
    await rm(root, { recursive: true, force: true });
  }
});
