import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { newId } from "@crossover/protocol";
import {
  FileLogStore,
  type ExecutionDriver,
  type SandboxExecOutcome,
  type SandboxExecProcess,
  type SandboxExecTermination,
  type SandboxFileChanges,
  type SandboxResources,
} from "@crossover/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

const OUTPUT_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024;

let db: TestDatabase;
let root: string;
let address: string;
let server: CrossoverServer;
let driver: OutputExecutionDriver;
let logs: FileLogStore;
let socket: WebSocket | undefined;
let serial = 0;

class OutputExecutionDriver implements ExecutionDriver {
  private releaseGate!: () => void;
  private resolveOutputDone!: () => void;
  private readonly outputGate = new Promise<void>((resolve) => (this.releaseGate = resolve));
  readonly outputDone = new Promise<void>((resolve) => (this.resolveOutputDone = resolve));
  outputBytes = 0;
  private cancellation: SandboxExecTermination | undefined;

  async create({
    sandbox_id,
  }: Parameters<ExecutionDriver["create"]>[0]): Promise<SandboxResources> {
    return {
      volume_ref: `volume:${sandbox_id}`,
      container_ref: `container:${sandbox_id}`,
    };
  }

  async status(): Promise<SandboxFileChanges> {
    return { modified: [], added: [], deleted: [], truncated: false };
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}

  async exec(
    input: Parameters<NonNullable<ExecutionDriver["exec"]>>[0],
  ): Promise<SandboxExecProcess> {
    let finish!: (outcome: SandboxExecOutcome) => void;
    const finished = new Promise<SandboxExecOutcome>((resolve) => (finish = resolve));
    void this.outputGate
      .then(async () => {
        for (let written = 0; written < OUTPUT_BYTES; written += CHUNK_BYTES) {
          if (this.cancellation) break;
          const size = Math.min(CHUNK_BYTES, OUTPUT_BYTES - written);
          await input.onOutput("stdout", Buffer.alloc(size, 0x61));
          this.outputBytes += size;
        }
        finish(
          this.cancellation
            ? { exit_code: null, duration_ms: 1, reason: this.cancellation }
            : { exit_code: 0, duration_ms: 1, reason: "exit" },
        );
      })
      .catch(() => finish({ exit_code: null, duration_ms: 1, reason: "output_failed" }))
      .finally(() => this.resolveOutputDone());

    return {
      finished,
      cancel: async (reason) => {
        this.cancellation = reason;
        this.releaseOutput();
        finish({ exit_code: null, duration_ms: 1, reason });
      },
    };
  }

  releaseOutput(): void {
    this.releaseGate();
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-sandbox-output-e2e-"));
  driver = new OutputExecutionDriver();
  logs = new FileLogStore(join(root, ".sandbox-exec-logs"));
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `sandbox-output-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
  };
  server = await composeServer(config, {
    pool: db.pool,
    executionDriver: driver,
  });
  address = await server.app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  await server?.close();
  await db?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

const envelope = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `sandbox-output-e2e-${++serial}`,
});

const post = (url: string, payload: unknown, token?: string) =>
  server.app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: JSON.stringify(payload),
  });

async function ok(res: Awaited<ReturnType<typeof post>>, status = 200) {
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

async function until<T>(predicate: () => T | undefined, description: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("sandbox output composition", () => {
  it("tells a paused WebSocket client to resync after real exec output exceeds 1 MiB", async () => {
    const login = await ok(
      await post("/v1/auth/dev-login", {
        subject: `sandbox-output-owner-${newId("usr")}`,
        display_name: "Owner",
      }),
    );
    const created = await ok(
      await post(
        "/v1/commands",
        envelope("room.create", {
          slug: `sandbox-output-${++serial}`,
          name: "Sandbox output",
          objective: "Exercise composed execution output",
        }),
        login.session_token,
      ),
    );
    const roomId = created.response.room.id as string;
    const session = await ok(await post(`/v1/rooms/${roomId}/session`, {}, login.session_token));
    const ownerToken = session.tokens.access_token as string;
    const exec = await ok(
      await post(
        `/v1/rooms/${roomId}/commands`,
        envelope("sandbox.exec", { command: "write test output" }),
        ownerToken,
      ),
    );
    const execId = exec.response.exec_id as string;
    expect(await logs.get(execId)).toMatchObject({ exec_id: execId, output_bytes: 0 });

    const frames: Record<string, unknown>[] = [];
    const wsUrl = `${address.replace(/^http/, "ws")}/v1/rooms/${roomId}/ws`;
    const client = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    socket = client;
    client.on("message", (data) =>
      frames.push(JSON.parse(data.toString()) as Record<string, unknown>),
    );
    const errors: Error[] = [];
    client.on("error", (error) => errors.push(error));
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    client.send(
      JSON.stringify({
        type: "hello",
        protocol_version: 1,
        client: "sandbox-output-e2e",
        client_version: "1",
      }),
    );
    await until(() => frames.find((frame) => frame.type === "hello_ok"), "hello_ok");
    client.send(JSON.stringify({ type: "sandbox.output.subscribe", exec_id: execId, after: 0 }));
    const subscribed = await until(
      () => frames.find((frame) => frame.type === "sandbox.output.subscribed"),
      "sandbox.output.subscribed",
    );
    expect(subscribed).toMatchObject({ exec_id: execId, after: 0, last_sequence: 0 });

    const transport = client as unknown as {
      _socket: { pause(): void; resume(): void } | null;
    };
    expect(transport._socket).toBeTruthy();
    transport._socket!.pause();
    driver.releaseOutput();
    await driver.outputDone;
    expect(driver.outputBytes).toBeGreaterThan(1024 * 1024);
    for (let attempt = 0; attempt < 400; attempt++) {
      if ((await logs.get(execId))?.finished_at) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await logs.get(execId))?.finished_at).toBeDefined();
    const lastCursor = await logs.lastCursor(execId);
    let finishedPayload: unknown;
    for (let attempt = 0; attempt < 400; attempt++) {
      const { rows } = await db.pool.query<{ payload: unknown }>(
        `SELECT payload FROM events
         WHERE room_id = $1 AND type = 'sandbox.exec.finished' AND payload->>'exec_id' = $2`,
        [roomId, execId],
      );
      if (rows[0]) {
        finishedPayload = rows[0].payload;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(finishedPayload).toMatchObject({ exec_id: execId, exit_code: 0, log_ref: execId });
    expect(JSON.stringify(finishedPayload)).not.toContain("a".repeat(1024));

    transport._socket!.resume();
    const resync = await until(
      () => frames.find((frame) => frame.type === "sandbox.output.resync_required"),
      "sandbox.output.resync_required",
    );
    expect(resync).toMatchObject({ exec_id: execId });
    expect(resync["after"]).toBeLessThan(lastCursor);
    expect(errors).toEqual([]);
  }, 30_000);
});
