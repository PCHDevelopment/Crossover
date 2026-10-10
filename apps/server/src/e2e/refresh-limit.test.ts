import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

/** `POST /v1/auth/refresh` is limited per client address (T1106), through the real server and Redis. */

let db: TestDatabase;
let root: string;
let server: CrossoverServer;

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-refresh-limit-"));
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `refresh-limit-${process.pid}`,
    devLogin: false,
    healthImages: ["node:22-bookworm-slim"],
    refreshPerMinute: 3,
  };
  server = await composeServer(config, { pool: db.pool });
});

afterAll(async () => {
  await server?.close();
  await db?.drop();
  await rm(root, { recursive: true, force: true });
});

const refresh = (ip: string) =>
  server.app.inject({
    method: "POST",
    url: "/v1/auth/refresh",
    remoteAddress: ip,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ refresh_token: "rt_nonsense" }),
  });

describe("POST /v1/auth/refresh rate limit", () => {
  it("allows the configured attempts per address per minute, then RATE_LIMITED with Retry-After; other addresses are unaffected", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    for (let i = 0; i < 3; i++) expect((await refresh(ip)).statusCode).toBe(401);
    const limited = await refresh(ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect((await refresh("203.0.113.77")).statusCode).toBe(401);
  });
});
