import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import type { OAuthProvider } from "@crossover/gateway";
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
  readonly assertBadGitTokenRejected: () => Promise<void>;
}

const execFileAsync = promisify(execFile);
const root = new URL("../../../../", import.meta.url).pathname;
const GIT_NETWORK = "crossover-git";
const GIT_BRIDGE_IMAGE =
  "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392";
const GIT_BRIDGE_PORT = 8081;

const gitIdentity = {
  GIT_AUTHOR_NAME: "Crossover E2E",
  GIT_AUTHOR_EMAIL: "e2e@example.com",
  GIT_COMMITTER_NAME: "Crossover E2E",
  GIT_COMMITTER_EMAIL: "e2e@example.com",
};
const runGit = (cwd: string, args: string[]) =>
  git(args, { cwd, timeoutMs: 30_000, env: gitIdentity });

async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a test port");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

/** Ensure the shared DockerExecutionDriver network exists; parallel jobs may use it. */
async function ensureGitNetwork(): Promise<void> {
  const assertInternal = async () => {
    const inspected = await execFileAsync(
      "docker",
      ["network", "inspect", "--format", "{{.Internal}}", GIT_NETWORK],
      { timeout: 10_000 },
    );
    if (inspected.stdout.trim() !== "true")
      throw new Error("The existing " + GIT_NETWORK + " network is not internal");
  };
  const { stdout } = await execFileAsync(
    "docker",
    ["network", "ls", "--filter", "name=^" + GIT_NETWORK + "$", "--format", "{{.Name}}"],
    { timeout: 10_000 },
  );
  if (stdout.split(/\r?\n/).some((name) => name.trim() === GIT_NETWORK)) {
    await assertInternal();
    return;
  }
  try {
    await execFileAsync(
      "docker",
      ["network", "create", "--internal", "--label", "crossover.git=true", GIT_NETWORK],
      { timeout: 10_000 },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!detail.toLowerCase().includes("already exists")) throw error;
  }
  // Another worker may have created the network after our initial list.
  await assertInternal();
}

/** Bridge only the host-bound Git listener hop; the production fetcher and HMAC remain real. */
async function startGitSocketBridge(containerName: string, socketDirectory: string): Promise<void> {
  const bridge = [
    "const net = require('node:net');",
    "const server = net.createServer((client) => {",
    "const upstream = net.createConnection('/bridge/git.sock');",
    "client.pipe(upstream); upstream.pipe(client);",
    "const close = () => { client.destroy(); upstream.destroy(); };",
    "client.on('error', close); upstream.on('error', close);",
    "client.on('close', () => upstream.destroy());",
    "upstream.on('close', () => client.destroy());",
    "});",
    "server.on('error', (error) => { console.error(error); process.exit(1); });",
    `server.listen(${GIT_BRIDGE_PORT}, '0.0.0.0');`,
  ].join(" ");
  await execFileAsync(
    "docker",
    [
      "run",
      "--detach",
      "--init",
      "--name",
      containerName,
      "--label",
      "crossover.test.git-bridge=true",
      "--network",
      GIT_NETWORK,
      "--read-only",
      "--user=1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory=128m",
      "--cpus=0.5",
      "--pids-limit=32",
      "--tmpfs",
      "/tmp:rw,nosuid,noexec,size=16m",
      "--mount",
      `type=bind,source=${socketDirectory},target=/bridge,readonly`,
      GIT_BRIDGE_IMAGE,
      "node",
      "-e",
      bridge,
    ],
    { timeout: 30_000 },
  );
}

/** Exercise the same bridge once with an invalid bearer token and require the real Git app to reject it. */
async function assertBadGitTokenRejected(containerName: string): Promise<void> {
  const probe = [
    "(async () => {",
    "const url = process.argv[1];",
    "const deadline = Date.now() + 10000;",
    "while (true) {",
    "let response;",
    "try { response = await fetch(url, { headers: { authorization: 'Bearer invalid-test-token' } }); }",
    "catch (error) { if (Date.now() >= deadline) throw error; await new Promise((resolve) => setTimeout(resolve, 100)); continue; }",
    "if (response.status !== 401) throw new Error(`Expected 401, got ${response.status}`);",
    "console.log(response.status); return;",
    "}",
    "})().catch((error) => { console.error(error); process.exitCode = 1; });",
  ].join(" ");
  const url = `http://${containerName}:${GIT_BRIDGE_PORT}/git/room_probe/sandbox_probe/0/info/refs?service=git-upload-pack`;
  const { stdout } = await execFileAsync(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      "--network",
      GIT_NETWORK,
      "--read-only",
      "--user=1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--memory=128m",
      "--cpus=0.5",
      "--pids-limit=32",
      "--tmpfs",
      "/tmp:rw,nosuid,noexec,size=16m",
      GIT_BRIDGE_IMAGE,
      "node",
      "-e",
      probe,
      url,
    ],
    { timeout: 30_000 },
  );
  if (stdout.trim() !== "401")
    throw new Error(
      `The Git listener did not reject a bad token through the bridge: ${stdout.trim()}`,
    );
}

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
  let gitSocketDirectory: string;
  let gitSocketPath: string;
  let gitBridgeContainer: string;
  let gitInternalTokenSecret: string;
  let gitBridgeStarted = false;
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
    gitSocketDirectory = join(dir, "git-bridge");
    await mkdir(gitSocketDirectory, { mode: 0o755 });
    await chmod(gitSocketDirectory, 0o755);
    gitSocketPath = join(gitSocketDirectory, "git.sock");
    gitBridgeContainer = `crossover-web-git-bridge-${process.pid}-${randomBytes(6).toString("hex")}`;
    gitInternalTokenSecret = randomBytes(32).toString("hex");
    const port = await reservePort();
    baseUrl = `http://127.0.0.1:${port}`;
    await ensureGitNetwork();
    upstreamDir = join(dir, "upstream");
    await mkdir(upstreamDir, { recursive: true });
    await runGit(upstreamDir, ["init", "-q", "-b", "main"]);
    await writeFile(join(upstreamDir, "README.md"), "# Browser acceptance fixture\n");
    const sourceDir = join(upstreamDir, "src");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, "auth.js"),
      [
        "export function createSessionToken(userId) {",
        '  const tokenPrefix = "token:";',
        "  return `${tokenPrefix}${userId}`;",
        "}",
        "",
        "export function sessionDurationSeconds() {",
        "  return 300;",
        "}",
        "",
        ...Array.from(
          { length: 55 },
          (_, index) => `// Existing authentication notes ${index + 1}`,
        ),
        "",
      ].join("\n"),
    );
    await writeFile(
      join(sourceDir, "auth.test.js"),
      [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'import * as auth from "./auth.js";',
        "",
        'test("authentication token lifetime is available", () => {',
        "  assert.equal(auth.sessionDurationSeconds(), 300);",
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(sourceDir, "api.test.js"),
      [
        'import assert from "node:assert/strict";',
        'import { existsSync } from "node:fs";',
        'import test from "node:test";',
        "",
        'test("API routes use the current token helper", async (context) => {',
        '  if (!existsSync(new URL("./api.js", import.meta.url))) {',
        '    context.skip("the API route is added in the walkthrough");',
        "    return;",
        "  }",
        '  const { createLoginResponse } = await import("./api.js");',
        '  assert.equal(createLoginResponse("peter"), "token:peter:agent-a:peter-two");',
        "});",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(upstreamDir, "package.json"),
      JSON.stringify({
        name: "widgets",
        type: "module",
        scripts: { typecheck: "node --check src/auth.js", test: "node --test" },
      }),
    );
    await runGit(upstreamDir, ["add", "README.md", "package.json", "src"]);
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
    const publicBaseUrl = baseUrl;
    const stubOAuthProvider: OAuthProvider = {
      name: "stub",
      authorizationUrl({ state }) {
        const url = new URL("/__test/oauth", publicBaseUrl);
        url.searchParams.set("state", state);
        return url.toString();
      },
      async identity({ code }) {
        if (code !== "e2e-stub-code") throw new Error("Invalid test authorization code");
        return { provider: "stub", subject: "web-e2e-user", display_name: "E2E User" };
      },
    };
    const config: ServerConfig = {
      databaseUrl: "unused: test pool is injected",
      redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
      workspaceRoot: join(dir, "workspaces"),
      host: "127.0.0.1",
      port,
      nodeId: `web-e2e-${process.pid}`,
      devLogin: true,
      oauth: { publicBaseUrl },
      healthImages: ["node:22-bookworm-slim"],
      awsPluginImage:
        "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392",
      gitInternalContainer: gitBridgeContainer,
      gitInternalTokenSecret,
      gitFetcherImage: "crossover-git-fetcher:test",
      webRoot,
    };
    server = await composeServer(config, {
      pool: db.pool,
      oauthProviders: { stub: stubOAuthProvider },
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
    server.app.get<{ Querystring: { state?: string } }>("/__test/oauth", async (request, reply) => {
      const state = request.query.state;
      if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) return reply.status(400).send();
      const callback = new URL("/v1/auth/oauth/stub/callback", publicBaseUrl);
      callback.searchParams.set("state", state);
      callback.searchParams.set("code", "e2e-stub-code");
      return reply.redirect(callback.toString());
    });
    await server.gitApp.listen({ path: gitSocketPath });
    await chmod(gitSocketPath, 0o666);
    // Production runs the server container itself on crossover-git. This test bridges that one hop
    // from the fetcher network to the host's real Git listener through a fixture-only Unix socket.
    await startGitSocketBridge(gitBridgeContainer, gitSocketDirectory);
    gitBridgeStarted = true;
    server.app.addHook("onError", async (request, _reply, error) => {
      console.error(`[web-e2e request ${request.method} ${request.url}]`, error);
    });
    baseUrl = await server.app.listen({ port, host: "127.0.0.1" });
    browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  }, 180_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    const attempt = async (action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };
    await attempt(() => browser?.close());
    // Remove this fixture's bridge by its generated name before server shutdown can block cleanup.
    if (gitBridgeStarted)
      await attempt(() =>
        execFileAsync("docker", ["container", "rm", "--force", gitBridgeContainer], {
          timeout: 10_000,
        }),
      );
    await attempt(() => server?.close());
    await attempt(() => db?.drop());
    if (dir) await attempt(() => rm(dir, { recursive: true, force: true }));
    if (errors.length) throw new AggregateError(errors, "Web e2e fixture cleanup failed");
  }, 180_000);

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
    assertBadGitTokenRejected: () => assertBadGitTokenRejected(gitBridgeContainer),
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
