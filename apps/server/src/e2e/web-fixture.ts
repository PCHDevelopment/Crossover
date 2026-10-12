import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { git, type UpstreamFetcher } from "@crossover/workspace";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

export interface WebFixture {
  readonly db: TestDatabase;
  readonly baseUrl: string;
  readonly browser: Browser | undefined;
  readonly executablePath: string | undefined;
  readonly inCi: boolean;
}

const execFileAsync = promisify(execFile);
const root = new URL("../../../../", import.meta.url).pathname;

const gitIdentity = {
  GIT_AUTHOR_NAME: "Crossover E2E",
  GIT_AUTHOR_EMAIL: "e2e@example.com",
  GIT_COMMITTER_NAME: "Crossover E2E",
  GIT_COMMITTER_EMAIL: "e2e@example.com",
};
const runGit = (cwd: string, args: string[]) =>
  git(args, { cwd, timeoutMs: 30_000, env: gitIdentity });

/** A Chromium to drive: Playwright's own install, or the one the environment provides. */
function chromiumPath(): string | undefined {
  const candidates = [
    process.env["CHROMIUM_PATH"],
    chromium.executablePath(),
    process.env["PLAYWRIGHT_BROWSERS_PATH"] &&
      `${process.env["PLAYWRIGHT_BROWSERS_PATH"]}/chromium`,
  ];
  return candidates.find((path): path is string => !!path && existsSync(path));
}

/** Register an isolated real-server/browser fixture for one web E2E test file. */
export function registerWebFixture(): WebFixture {
  let db: TestDatabase;
  let dir: string;
  let server: CrossoverServer;
  let baseUrl: string;
  let browser: Browser | undefined;
  let upstreamDir: string;
  let remoteRepo: string;
  const executablePath = chromiumPath();
  const inCi = Boolean(process.env["CI"]);

  const upstreamFetcher: UpstreamFetcher = {
    async fetch() {
      const cloneDir = await mkdtemp(join(tmpdir(), "crossover-web-upstream-"));
      const repo = join(cloneDir, "repo.git");
      await runGit(cloneDir, ["clone", "-q", "--bare", upstreamDir, repo]);
      const sha = (
        await git(["rev-parse", "HEAD"], { gitDir: repo, timeoutMs: 10_000 })
      ).stdout.trim();
      return {
        repo,
        ref: "HEAD",
        sha,
        cleanup: () => rm(cloneDir, { recursive: true, force: true }),
      };
    },
  };

  beforeAll(async () => {
    if (!executablePath) {
      if (inCi)
        throw new Error("No Chromium found in CI (install it: playwright-core install chromium)");
      return;
    }
    db = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), "crossover-web-e2e-"));
    upstreamDir = join(dir, "upstream");
    await mkdir(upstreamDir, { recursive: true });
    await runGit(upstreamDir, ["init", "-q", "-b", "main"]);
    await writeFile(join(upstreamDir, "README.md"), "# Browser acceptance fixture\n");
    await writeFile(
      join(upstreamDir, "package.json"),
      JSON.stringify({
        name: "widgets",
        scripts: { typecheck: "tsc --noEmit", test: "vitest run" },
      }),
    );
    await runGit(upstreamDir, ["add", "README.md", "package.json"]);
    await runGit(upstreamDir, ["commit", "-q", "-m", "Initial"]);
    const remoteParent = join(dir, "remote");
    await mkdir(remoteParent);
    await runGit(remoteParent, ["init", "-q", "--bare", "-b", "main", "widgets.git"]);
    remoteRepo = join(remoteParent, "widgets.git");
    const webRoot = join(dir, "web");
    await execFileAsync(
      "pnpm",
      ["--filter", "@crossover/web", "exec", "vite", "build", "--outDir", webRoot],
      { cwd: root, timeout: 120_000 },
    );
    const config: ServerConfig = {
      databaseUrl: "unused: test pool is injected",
      redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
      workspaceRoot: join(dir, "workspaces"),
      host: "127.0.0.1",
      port: 0,
      nodeId: `web-e2e-${process.pid}`,
      devLogin: true,
      healthImages: ["node:22-bookworm-slim"],
      webRoot,
    };
    server = await composeServer(config, {
      pool: db.pool,
      upstream: {
        fetcher: upstreamFetcher,
        resolve: async () => ["93.184.216.34"],
        pusher: {
          async push(request) {
            await git(
              ["push", "--porcelain", remoteRepo, `${request.commit}:refs/heads/${request.branch}`],
              { gitDir: request.repo, timeoutMs: 30_000 },
            );
          },
        },
        pullRequests: {
          async create() {
            return { url: "https://github.com/acme/widgets/pull/42", number: 42 };
          },
        },
      },
    });
    baseUrl = await server.app.listen({ port: 0, host: "127.0.0.1" });
    browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    await db?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  return {
    get db() {
      return db;
    },
    get baseUrl() {
      return baseUrl;
    },
    get browser() {
      return browser;
    },
    executablePath,
    inCi,
  };
}

export const manifest = (name: string) => ({
  name,
  operator: { name: "Peter", contact: "peter@example.com" },
  vendor: "Anthropic",
  model: "m",
  client: "sdk-ts",
  client_version: "1",
  description: `${name} works here`,
});
