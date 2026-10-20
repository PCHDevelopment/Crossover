import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "@crossover/db";
import { describe, expect, it } from "vitest";
import { git } from "./git.js";
import { ZoektIndexer } from "./zoekt-index.js";

const image = "crossover-zoekt:test";
let imageAvailable = false;
try {
  execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 1_000 });
  imageAvailable = true;
} catch {
  /* CI builds the image before running tests. */
}

describe.skipIf(!imageAvailable && !process.env["CI"])("Zoekt index Docker integration", () => {
  it("indexes a bare room repository and exposes the DB head through /api/list", async () => {
    const root = await mkdtemp(join(tmpdir(), "zoekt-docker-test-"));
    const repo = join(root, "room_A.git");
    const indexDir = join(root, "index");
    const container = `crossover-zoekt-test-${process.pid}`;
    let started = false;
    try {
      await mkdir(indexDir);
      await chmod(root, 0o755);
      await chmod(indexDir, 0o777);
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
          `${repo}:${repo}:ro`,
          "-v",
          `${indexDir}:${indexDir}`,
          image,
        ],
      });
      expect(await indexer.index("room_A", 1, new AbortController().signal)).toBe("indexed");
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
      const port = Number(mapping.trim().split(":").at(-1));
      let version: string | undefined;
      for (let attempt = 0; attempt < 30 && !version; attempt++) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/list`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ Q: "repo:^room_A$" }),
          });
          const body = (await response.json()) as {
            List?: { Repos?: Array<{ Repository?: { Branches?: Array<{ Version?: string }> } }> };
          };
          version = body.List?.Repos?.[0]?.Repository?.Branches?.find((b) => b.Version)?.Version;
        } catch {
          /* Sidecar startup can take a moment. */
        }
        if (!version) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(version).toBe(commit);
    } finally {
      if (started) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
