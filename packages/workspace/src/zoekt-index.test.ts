import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "@crossover/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "./git.js";
import { ZoektIndexer, zoektArgs } from "./zoekt-index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zoekt-index-test-"));
  roots.push(root);
  const repo = join(root, "room_A.git");
  const indexDir = join(root, "index");
  await git(["init", "--bare", repo], { timeoutMs: 10_000 });
  const tree = (
    await git(["mktree"], { gitDir: repo, input: "", timeoutMs: 10_000 })
  ).stdout.trim();
  const commit = (
    await git(["commit-tree", tree, "-m", "test"], {
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
  const canonical = (
    await git(["commit-tree", tree, "-p", commit, "-m", "other head"], {
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
  await git(["update-ref", "refs/room/canonical", canonical], { gitDir: repo, timeoutMs: 10_000 });
  const pool = {
    query: async (sql: string) => ({
      rows: sql.includes("SELECT w.repo_path")
        ? [
            {
              repo_path: repo,
              commit_sha: commit,
              revision: "1",
              status: "ACTIVE",
              purge_started_at: null,
            },
          ]
        : [{ revision: "1", purge_started_at: null }],
    }),
  } as unknown as Pool;
  return { root, repo, indexDir, commit, canonical, pool };
}

describe("ZoektIndexer", () => {
  it("uses the documented canonical-head index arguments and a DB-derived private ref", async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, "record.cjs"),
      "require('fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))",
    );
    const output = join(f.root, "args.json");
    const indexer = new ZoektIndexer({
      pool: f.pool,
      indexDir: f.indexDir,
      command: [process.execPath, join(f.root, "record.cjs"), output],
      concurrency: 1,
      timeoutMs: 10_000,
    });
    expect(await indexer.index("room_A", 1, new AbortController().signal)).toBe("indexed");
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(
      zoektArgs(f.indexDir, "room_A", f.repo),
    );
    expect(
      (
        await git(["rev-parse", "refs/zoekt/head"], { gitDir: f.repo, timeoutMs: 10_000 })
      ).stdout.trim(),
    ).toBe(f.commit);
    expect(
      (
        await git(["rev-parse", "refs/room/canonical"], { gitDir: f.repo, timeoutMs: 10_000 })
      ).stdout.trim(),
    ).toBe(f.canonical);
    await indexer.close();
  });

  it("removes only exact room shard prefixes", async () => {
    const f = await fixture();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(f.indexDir);
    for (const name of [
      "room_A_v16.00000.zoekt",
      "room_A_v16.00001.zoekt",
      "room_AB_v16.00000.zoekt",
    ])
      await writeFile(join(f.indexDir, name), "shard");
    const indexer = new ZoektIndexer({
      pool: f.pool,
      indexDir: f.indexDir,
      concurrency: 1,
      timeoutMs: 10_000,
    });
    await indexer.removeRoom("room_A");
    expect(await readdir(f.indexDir)).toEqual(["room_AB_v16.00000.zoekt"]);
    expect(await indexer.index("room_A", 1, new AbortController().signal)).toBe("skipped");
    await indexer.close();
  });

  it("limits child processes across rooms", async () => {
    const f = await fixture();
    const script = join(f.root, "slow.cjs");
    const log = join(f.root, "events.txt");
    await writeFile(
      script,
      `const fs=require('fs'); const args=process.argv.slice(3);
      const room=args[args.indexOf('-shard_prefix_override')+1];
      fs.appendFileSync(process.argv[2], 'start '+room+'\\n');
      setTimeout(() => fs.appendFileSync(process.argv[2], 'end '+room+'\\n'), 100);`,
    );
    const indexer = new ZoektIndexer({
      pool: f.pool,
      indexDir: f.indexDir,
      command: [process.execPath, script, log],
      concurrency: 1,
      timeoutMs: 10_000,
    });
    await Promise.all(
      ["room_A", "room_B", "room_C"].map((room) =>
        indexer.index(room, 1, new AbortController().signal),
      ),
    );
    const events = (await readFile(log, "utf8")).trim().split("\n");
    expect(events).toHaveLength(6);
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]).toMatch(/^start room_/);
      expect(events[i + 1]).toBe(events[i]!.replace("start", "end"));
    }
    await indexer.close();
  });

  it("coalesces queued revisions to the latest DB head", async () => {
    const f = await fixture();
    const script = join(f.root, "record-latest.cjs");
    const log = join(f.root, "latest.txt");
    await writeFile(script, "require('fs').appendFileSync(process.argv[2], 'indexed\\n')");
    const pool = {
      query: async (sql: string) => ({
        rows: sql.includes("SELECT w.repo_path")
          ? [
              {
                repo_path: f.repo,
                commit_sha: f.commit,
                revision: "3",
                status: "ACTIVE",
                purge_started_at: null,
              },
            ]
          : [{ revision: "3", purge_started_at: null }],
      }),
    } as unknown as Pool;
    const indexer = new ZoektIndexer({
      pool,
      indexDir: f.indexDir,
      command: [process.execPath, script, log],
      concurrency: 1,
      timeoutMs: 10_000,
    });
    indexer.schedule("room_A", 1);
    indexer.schedule("room_A", 2);
    indexer.schedule("room_A", 3);
    await vi.waitFor(async () => expect(await readFile(log, "utf8")).toBe("indexed\n"));
    await indexer.close();
    expect(await readFile(log, "utf8")).toBe("indexed\n");
  });

  it("kills an index process after the configured timeout", async () => {
    const f = await fixture();
    const script = join(f.root, "hang.cjs");
    await writeFile(script, "setTimeout(() => {}, 10000)");
    const indexer = new ZoektIndexer({
      pool: f.pool,
      indexDir: f.indexDir,
      command: [process.execPath, script],
      concurrency: 1,
      timeoutMs: 150,
    });
    await expect(indexer.index("room_A", 1, new AbortController().signal)).rejects.toThrow(
      /SIGKILL/,
    );
    await indexer.close();
  });
});
