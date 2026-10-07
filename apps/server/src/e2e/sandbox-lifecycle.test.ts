import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { newId } from "@crossover/protocol";
import type { ExecutionDriver, SandboxResources } from "@crossover/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

let db: TestDatabase;
let root: string;
let server: CrossoverServer;
let driver: RecordingExecutionDriver;
let serial = 0;

class RecordingExecutionDriver implements ExecutionDriver {
  readonly stopped: string[] = [];
  readonly destroyed: string[] = [];

  async create({
    sandbox_id,
  }: Parameters<ExecutionDriver["create"]>[0]): Promise<SandboxResources> {
    return {
      volume_ref: `volume:${sandbox_id}`,
      container_ref: `container:${sandbox_id}`,
    };
  }

  async start(_input: Parameters<ExecutionDriver["start"]>[0]): Promise<void> {}

  async stop({ sandbox_id }: Parameters<ExecutionDriver["stop"]>[0]): Promise<void> {
    this.stopped.push(sandbox_id);
  }

  async destroy({ sandbox_id }: Parameters<ExecutionDriver["destroy"]>[0]): Promise<void> {
    this.destroyed.push(sandbox_id);
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-sandbox-e2e-"));
  driver = new RecordingExecutionDriver();
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `sandbox-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
  };
  server = await composeServer(config, { pool: db.pool, executionDriver: driver });
});

afterAll(async () => {
  await server?.close();
  await db?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

const envelope = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `sandbox-e2e-${++serial}`,
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

describe("sandbox lifecycle composition (§14.6)", () => {
  it("wires room freeze, participant removal, and archive to the execution service", async () => {
    const login = await ok(
      await post("/v1/auth/dev-login", {
        subject: `sandbox-owner-${newId("usr")}`,
        display_name: "Owner",
      }),
    );
    const created = await ok(
      await post(
        "/v1/commands",
        envelope("room.create", {
          slug: `sandbox-e2e-${++serial}`,
          name: "Sandbox lifecycle",
          objective: "Verify composed cleanup hooks",
        }),
        login.session_token,
      ),
    );
    const roomId = created.response.room.id as string;
    const owner = await ok(await post(`/v1/rooms/${roomId}/session`, {}, login.session_token));
    const ownerToken = owner.tokens.access_token as string;
    const command = (method: string, params: Record<string, unknown> = {}) =>
      post(`/v1/rooms/${roomId}/commands`, envelope(method, params), ownerToken);

    const invite = await ok(await command("room.invite", { role: "DEVELOPER" }));
    const agent = await ok(
      await post(`/v1/rooms/${roomId}/join`, {
        token: invite.one_time.token,
        manifest: {
          name: "Sandbox agent",
          operator: { name: "Peter", contact: "peter@example.com" },
          vendor: "Anthropic",
          model: "test-model",
          client: "mcp",
          client_version: "1.0.0",
          description: "Lifecycle test participant",
        },
      }),
      201,
    );
    const agentId = agent.participant_id as string;
    const agentSandbox = await server.execution.ensure(roomId, agentId);

    await ok(await command("room.freeze"));
    expect(await server.execution.get(roomId, agentId)).toMatchObject({
      id: agentSandbox.id,
      status: "HIBERNATED",
    });
    expect(driver.stopped).toEqual([agentSandbox.id]);

    await ok(await command("room.resume"));
    await ok(await command("participants.remove", { participant_id: agentId }));
    expect(await server.execution.get(roomId, agentId)).toMatchObject({
      id: agentSandbox.id,
      status: "DESTROYED",
    });

    const { rows } = await db.pool.query<{ id: string }>(
      "SELECT id FROM participants WHERE room_id = $1 AND authority = 'OWNER'",
      [roomId],
    );
    const ownerId = rows[0]!.id;
    const ownerSandbox = await server.execution.ensure(roomId, ownerId);
    await ok(await command("room.archive"));
    expect(await server.execution.get(roomId, ownerId)).toMatchObject({
      id: ownerSandbox.id,
      status: "DESTROYED",
    });
    expect(driver.destroyed).toEqual([agentSandbox.id, ownerSandbox.id]);

    // The room-wide read registry remains explicit about participant visibility for every read.
    for (const read of server.dispatcher.commandInfo().filter((entry) => !entry.mutating)) {
      expect(["participant", "own", "none"], read.method).toContain(read.view);
      if (read.view === "none") expect(read.view_reason, read.method).toBeTruthy();
    }
  });
});
