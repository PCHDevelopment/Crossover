import { execFile, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

/**
 * The Python SDK (T1103) against a real server, through its own contract tests
 * (`clients/python/tests`): the same behaviour the TypeScript SDK's e2e tests hold, in Python.
 * Skipped where Python 3.10+ with `httpx` and `websockets` isn't installed (CI installs them).
 */

const execFileAsync = promisify(execFile);
const root = new URL("../../../../", import.meta.url).pathname;
const python = process.env["PYTHON"] ?? "python3";
const ready =
  spawnSync(python, ["-c", "import sys, httpx, websockets; assert sys.version_info >= (3, 10)"], {
    stdio: "ignore",
  }).status === 0;

let db: TestDatabase;
let dir: string;
let server: CrossoverServer;
let baseUrl: string;
let control: Server;

beforeAll(async () => {
  if (!ready) return;
  db = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), "crossover-python-e2e-"));
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: dir,
    host: "127.0.0.1",
    port: 0,
    nodeId: `python-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
  };
  server = await composeServer(config, { pool: db.pool });
  baseUrl = await server.app.listen({ port: 0, host: "127.0.0.1" });
  // The Python tests can't reach the database; this lets them expire an agent's access tokens.
  control = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/expire") {
      db.pool
        .query(
          `UPDATE auth_tokens SET expires_at = now() - interval '1 minute'
           WHERE room_id = $1 AND kind = 'ACCESS'
             AND participant_id IN (SELECT id FROM participants WHERE room_id = $1 AND kind = 'AGENT')`,
          [url.searchParams.get("room")],
        )
        .then(() => res.writeHead(200).end("ok"))
        .catch(() => res.writeHead(500).end());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
}, 60_000);

afterAll(async () => {
  control?.close();
  await server?.close();
  await db?.drop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!ready)("Python SDK contract", () => {
  it("passes its contract tests against the real server", async () => {
    const env = {
      ...process.env,
      PYTHONPATH: join(root, "clients/python"),
      CROSSOVER_BASE_URL: baseUrl,
      CROSSOVER_CONTROL_URL: `http://127.0.0.1:${(control.address() as AddressInfo).port}`,
    };
    const run = await execFileAsync(
      python,
      ["-m", "unittest", "discover", "-s", "clients/python/tests", "-t", "clients/python", "-v"],
      { cwd: root, env, timeout: 170_000 },
    ).catch((error: { stdout?: string; stderr?: string }) => {
      throw new Error(`${error.stderr ?? ""}\n${error.stdout ?? ""}`);
    });
    const output = `${run.stdout}\n${run.stderr}`;
    expect(output).toMatch(/\nOK/);
    expect(output).not.toMatch(/FAILED|ERROR:/);
  }, 180_000);
});
