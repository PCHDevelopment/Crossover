import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { withTransaction } from "@crossover/db";
import {
  Dispatcher,
  findOrCreateUser,
  issueTokens,
  registerCapabilityCommands,
  registerTaskCommands,
  registerTaskHeartbeat,
  registerTaskLifecycleCommands,
  registerTaskReadCommands,
  tasksAssignParams,
  tasksBlockParams,
  tasksCreateParams,
  tasksGetParams,
  tasksHeartbeatParams,
  tasksListParams,
  tasksSubmitParams,
  tasksReviewParams,
  tasksUpdateParams,
  taskVersionParams,
  type Dispatcher as KernelDispatcher,
  registerInviteCommands,
  registerJoinCommand,
  registerRoomCommands,
  type RoomInviteSecret,
  type TokenPair,
} from "@crossover/kernel";
import { authorize } from "@crossover/policy";
import { newId } from "@crossover/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerMcp } from "./server.js";
import { BASE_TOOLS, MCP_TOOLS, TASK_TOOLS } from "./tools.js";
import { provisionWorkspace, registerWorkspaceCommands } from "@crossover/workspace";

let db: TestDatabase;
let pool: Pool;
let n = 0;
const apps: FastifyInstance[] = [];
const clients: Client[] = [];
const workspaceDirs: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await Promise.all(apps.map((a) => a.close()));
  await db.drop();
  await Promise.all(workspaceDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const manifest = {
  name: "Claude-1",
  operator: { name: "Peter", contact: "p@example.com" },
  vendor: "Anthropic",
  model: "m",
  client: "mcp",
  client_version: "1",
  description: "d",
};

async function setup(tools?: Parameters<typeof registerMcp>[1]["tools"]) {
  const dispatcher = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerRoomCommands(dispatcher);
  registerInviteCommands(dispatcher);
  registerJoinCommand(dispatcher);
  registerCapabilityCommands(dispatcher);
  registerWorkspaceCommands(dispatcher);
  registerTaskCommands(dispatcher);
  registerTaskReadCommands(dispatcher);
  registerTaskLifecycleCommands(dispatcher);
  registerTaskHeartbeat(dispatcher);
  const app = Fastify();
  registerMcp(app, { dispatcher, pool, ...(tools ? { tools } : {}) });
  apps.push(app);
  const url = await app.listen({ port: 0, host: "127.0.0.1" });

  const user = await findOrCreateUser(pool, {
    provider: "test",
    subject: `s-${++n}`,
    display_name: "Peter",
  });
  const created = await dispatcher.dispatchRoomless(
    { user_id: user.id, display_name: "Peter" },
    {
      id: newId("cmd"),
      method: "room.create",
      params: { slug: `mcp-${++n}-${Date.now().toString(36)}`, name: "n", objective: "Ship it" },
      idempotency_key: `k-${++n}`,
    },
  );
  const { room, participant } = created.response as {
    room: { id: string };
    participant: { id: string };
  };
  const workspaceDir = await mkdtemp(join(tmpdir(), "crossover-mcp-workspace-"));
  workspaceDirs.push(workspaceDir);
  await withTransaction(pool, (client) => provisionWorkspace(client, room.id, workspaceDir));
  const owner = await issueTokens(pool, participant.id);

  const invite = await dispatcher.dispatch(
    {
      participant_id: participant.id,
      room_id: room.id,
      kind: "HUMAN",
      authority: "OWNER",
      role: "LEAD",
    },
    {
      id: newId("cmd"),
      method: "room.invite",
      params: { role: "DEVELOPER" },
      idempotency_key: `k-${++n}`,
    },
  );
  const joined = await dispatcher.dispatchAnonymous(
    "room.join",
    { token: (invite.one_time as RoomInviteSecret).token, manifest },
    room.id,
  );
  return {
    app,
    url: `${url}/mcp`,
    room: room.id,
    owner,
    ownerId: participant.id,
    agent: joined.one_time as TokenPair,
    agentId: (joined.response as { participant_id: string }).participant_id,
  };
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as never,
  );
  clients.push(client);
  return client;
}

const rawPost = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("MCP server (T707)", () => {
  it("tools/list works for an authenticated agent", async () => {
    const s = await setup();
    const client = await connect(s.url, s.agent.access_token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
    for (const tool of tools) expect(tool.description).toBeTruthy();
  });

  it("exposes canonical workspace tools through the authenticated dispatcher", async () => {
    const s = await setup();
    const client = await connect(s.url, s.agent.access_token);
    const applied = await client.callTool({
      name: "apply_changeset",
      arguments: {
        source: "API",
        message: "Create MCP file",
        base_workspace_revision: 0,
        operations: [{ type: "create", path: "docs/readme.md", content: "Crossover MCP" }],
      },
    });
    expect(applied.isError).toBeFalsy();
    expect(JSON.parse((applied.content as { text: string }[])[0]!.text)).toMatchObject({
      status: "APPLIED",
      applied_revision: 1,
    });

    const read = await client.callTool({
      name: "read_file",
      arguments: { path: "docs/readme.md" },
    });
    expect(JSON.parse((read.content as { text: string }[])[0]!.text)).toMatchObject({
      content: "Crossover MCP",
      encoding: "utf8",
    });
    const list = await client.callTool({ name: "list_dir", arguments: { path: "docs" } });
    expect(JSON.parse((list.content as { text: string }[])[0]!.text)).toMatchObject({
      entries: [{ path: "docs/readme.md" }],
    });
    const grep = await client.callTool({ name: "grep", arguments: { query: "Crossover MCP" } });
    expect(JSON.parse((grep.content as { text: string }[])[0]!.text)).toMatchObject({
      matches: [expect.objectContaining({ path: "docs/readme.md" })],
    });
    const diff = await client.callTool({
      name: "diff",
      arguments: { from_revision: 0, to_revision: 1 },
    });
    expect(JSON.parse((diff.content as { text: string }[])[0]!.text).diff).toContain(
      "Crossover MCP",
    );
  });

  it("returns only health status through health_get for a scoped workspace reader", async () => {
    const s = await setup();
    const { rows: workspaces } = await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE room_id = $1",
      [s.room],
    );
    const runId = newId("health");
    const privateLog = "test failed at /private/build/secret.ts with token=fixture-secret";
    await pool.query(
      `INSERT INTO health_runs (id, workspace_id, room_id, revision, status, duration_ms, log)
       VALUES ($1, $2, $3, 0, 'RED', 12, $4)`,
      [runId, workspaces[0]!.id, s.room, privateLog],
    );
    await pool.query(
      `INSERT INTO capability_grants
       (id, room_id, participant_id, effect, capability, created_by)
       VALUES ($1, $2, $3, 'DENY', 'workspace.read', $4),
              ($5, $2, $3, 'GRANT', 'workspace.read:docs/**', $4)`,
      [newId("grant"), s.room, s.agentId, s.ownerId, newId("grant")],
    );
    const agent = await connect(s.url, s.agent.access_token);
    const result = await agent.callTool({ name: "health_get", arguments: { run_id: runId } });
    const body = JSON.parse((result.content as { text: string }[])[0]!.text) as Record<
      string,
      unknown
    >;
    expect(result.isError).toBeFalsy();
    expect(body).toMatchObject({ run_id: runId, revision: 0, status: "RED" });
    expect(body).not.toHaveProperty("summary");
    expect(body).not.toHaveProperty("log_tail");
    expect(JSON.stringify(body)).not.toContain("fixture-secret");
    expect(JSON.stringify(body)).not.toContain("/private/build");
  });

  it("rejects traversal and .git paths at the MCP boundary", async () => {
    const s = await setup();
    const client = await connect(s.url, s.agent.access_token);
    for (const path of ["../secret", ".git/config"]) {
      const result = await client
        .callTool({ name: "read_file", arguments: { path } })
        .catch((error: unknown) => error);
      if (result instanceof Error) {
        expect(result.message).toMatch(/MCP error|VALIDATION/);
        continue; // SDK surfaced the tool validation failure.
      }
      const toolResult = result as { isError?: boolean; content?: { text: string }[] };
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content![0]!.text).toMatch(/MCP error|VALIDATION/);
    }
  });

  it("scoped DENY hides names and search content and returns FORBIDDEN as isError", async () => {
    const s = await setup();
    const owner = await connect(s.url, s.owner.access_token);
    const agent = await connect(s.url, s.agent.access_token);
    const seeded = await owner.callTool({
      name: "apply_changeset",
      arguments: {
        source: "API",
        message: "Seed scoped files",
        base_workspace_revision: 0,
        operations: [
          { type: "create", path: "secrets/TOPSECRET", content: "needle private value" },
          { type: "create", path: "public/readme", content: "public value" },
        ],
      },
    });
    expect(seeded.isError).toBeFalsy();
    await pool.query(
      `INSERT INTO capability_grants
       (id, room_id, participant_id, effect, capability, created_by)
       VALUES ($1, $2, $3, 'DENY', 'workspace.read:secrets/**', $4)`,
      [newId("grant"), s.room, s.agentId, s.ownerId],
    );

    const list = await agent.callTool({ name: "list_dir", arguments: {} });
    expect(list.isError).toBeFalsy();
    const entries = JSON.parse((list.content as { text: string }[])[0]!.text).entries;
    expect(entries.map((entry: { path: string }) => entry.path)).toContain("public");
    expect(entries.map((entry: { path: string }) => entry.path)).not.toContain("secrets");

    const grep = await agent.callTool({
      name: "grep",
      arguments: { query: "needle private value" },
    });
    expect(grep.isError).toBeFalsy();
    expect(JSON.parse((grep.content as { text: string }[])[0]!.text).matches).toEqual([]);

    const read = await agent.callTool({
      name: "read_file",
      arguments: { path: "secrets/TOPSECRET" },
    });
    expect(read.isError).toBe(true);
    expect(JSON.parse((read.content as { text: string }[])[0]!.text)).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("retries apply_changeset idempotently with the same result", async () => {
    const s = await setup();
    const owner = await connect(s.url, s.owner.access_token);
    const args = {
      source: "API" as const,
      message: "Idempotent MCP apply",
      base_workspace_revision: 0,
      operations: [{ type: "create" as const, path: "docs/retry.md", content: "once" }],
      idempotency_key: "mcp-retry-key",
    };
    const first = await owner.callTool({ name: "apply_changeset", arguments: args });
    const retry = await owner.callTool({ name: "apply_changeset", arguments: args });
    expect(first.isError).toBeFalsy();
    expect(retry.isError).toBeFalsy();
    const firstBody = JSON.parse((first.content as { text: string }[])[0]!.text);
    const retryBody = JSON.parse((retry.content as { text: string }[])[0]!.text);
    expect(retryBody).toEqual(firstBody);
    expect(
      await pool.query("SELECT id FROM changesets WHERE room_id = $1", [s.room]),
    ).toMatchObject({ rowCount: 1 });
  });

  it("returns workspace conflicts as normal MCP tool results", async () => {
    const s = await setup();
    const owner = await connect(s.url, s.owner.access_token);
    const agent = await connect(s.url, s.agent.access_token);
    const apply = (client: Client, message: string, base: number, content: string) =>
      client.callTool({
        name: "apply_changeset",
        arguments: {
          source: "API",
          message,
          base_workspace_revision: base,
          operations: [{ type: base === 0 ? "create" : "modify", path: "docs/shared.md", content }],
        },
      });
    expect((await apply(owner, "Create shared file", 0, "base\n")).isError).toBeFalsy();
    expect((await apply(owner, "Advance shared file", 1, "head\n")).isError).toBeFalsy();
    const conflict = await apply(agent, "Submit stale edit", 1, "agent\n");
    expect(conflict.isError).toBeFalsy();
    expect(JSON.parse((conflict.content as { text: string }[])[0]!.text)).toMatchObject({
      status: "CONFLICT",
      conflicts: [expect.objectContaining({ path: "docs/shared.md" })],
    });
  });

  it.each([
    ["no token", {}],
    ["a malformed header", { authorization: "Basic abc" }],
    ["an unknown token", { authorization: "Bearer at_nope" }],
    ["a refresh token", { authorization: "Bearer rt_nope" }],
  ])("%s → 401 with the error body", async (_n, headers) => {
    const s = await setup();
    const res = await rawPost(s.url, headers);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    expect(await res.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED", retryable: false },
    });
  });

  it("calls a tool through the dispatcher, as the authenticated principal", async () => {
    const s = await setup();
    const client = await connect(s.url, s.agent.access_token);
    const state = await client.callTool({ name: "room_get_state", arguments: {} });
    expect(state.isError).toBeFalsy();
    const body = JSON.parse((state.content as { text: string }[])[0]!.text);
    expect(body.sections.room).toMatchObject({ id: s.room, objective: "Ship it" });

    const mine = await client.callTool({ name: "capabilities_list", arguments: {} });
    const caps = JSON.parse((mine.content as { text: string }[])[0]!.text);
    expect(caps).toMatchObject({ participant_id: s.agentId, role: "DEVELOPER" });
  });

  it("reports a command error as a tool error carrying the §16.3 body", async () => {
    const s = await setup();
    const client = await connect(s.url, s.agent.access_token);
    const res = await client.callTool({
      name: "capabilities_list",
      arguments: { participant_id: "part_nope" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse((res.content as { text: string }[])[0]!.text)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it("a mutating tool is authorized like any command: a developer can't invite", async () => {
    const s = await setup([
      ...BASE_TOOLS,
      {
        name: "room_invite",
        description: "Invite",
        method: "room.invite" as const,
        input: { role: z.enum(["DEVELOPER", "REVIEWER", "OBSERVER"]) },
        mutating: true,
      },
    ]);
    const url = s.url;
    const agent = await connect(url, s.agent.access_token);
    const denied = await agent.callTool({ name: "room_invite", arguments: { role: "DEVELOPER" } });
    expect(denied.isError).toBe(true);
    expect(JSON.parse((denied.content as { text: string }[])[0]!.text)).toMatchObject({
      error: { code: "FORBIDDEN", details: { missing_capability: "room.invite" } },
    });
    const owner = await connect(url, s.owner.access_token);
    const ok = await owner.callTool({
      name: "room_invite",
      arguments: { role: "DEVELOPER", idempotency_key: "same" },
    });
    expect(ok.isError).toBeFalsy();
    const again = await owner.callTool({
      name: "room_invite",
      arguments: { role: "DEVELOPER", idempotency_key: "same" },
    });
    expect(JSON.parse((again.content as { text: string }[])[0]!.text).invite_id).toBe(
      JSON.parse((ok.content as { text: string }[])[0]!.text).invite_id,
    );
  });

  it("validates tool arguments", async () => {
    const s = await setup();
    const client = await connect(s.url, s.agent.access_token);
    const res = await client
      .callTool({ name: "capabilities_list", arguments: { participant_id: 5 } })
      .catch((e: unknown) => e);
    // The SDK answers invalid arguments as a tool error or a protocol error; never success.
    const failed = res instanceof Error || (res as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
  });

  it("each agent is served as itself: two agents, two principals", async () => {
    const s = await setup();
    const a = await connect(s.url, s.agent.access_token);
    const o = await connect(s.url, s.owner.access_token);
    const text = async (c: Client) =>
      JSON.parse(
        (
          (await c.callTool({ name: "capabilities_list", arguments: {} })).content as {
            text: string;
          }[]
        )[0]!.text,
      );
    expect(await text(a)).toMatchObject({ role: "DEVELOPER", authority: "MEMBER" });
    expect(await text(o)).toMatchObject({ role: "LEAD", authority: "OWNER" });
  });

  it("a removed participant's token stops working", async () => {
    const s = await setup();
    await pool.query("UPDATE participants SET status = 'REMOVED' WHERE id = $1", [s.agentId]);
    const res = await rawPost(s.url, { authorization: `Bearer ${s.agent.access_token}` });
    expect(res.status).toBe(401);
  });

  it("GET and DELETE aren't supported (stateless server)", async () => {
    const s = await setup();
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(s.url, {
        method,
        headers: { authorization: `Bearer ${s.agent.access_token}` },
      });
      expect(res.status).toBe(405);
    }
  });
});

describe("MCP task tools (T708)", () => {
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    return { isError: Boolean(res.isError), body };
  };

  it("has a tool for every tasks.* command, and no tool for one that doesn't exist", () => {
    const methods: string[] = [];
    const recorder = { registerCommand: (def: { method: string }) => methods.push(def.method) };
    registerTaskCommands(recorder as unknown as KernelDispatcher);
    registerTaskReadCommands(recorder as unknown as KernelDispatcher);
    registerTaskLifecycleCommands(recorder as unknown as KernelDispatcher);
    registerTaskHeartbeat(recorder as unknown as KernelDispatcher);
    expect(methods.length).toBeGreaterThanOrEqual(15);
    expect(TASK_TOOLS.map((t) => t.method).sort()).toEqual([...methods].sort());
    expect(new Set(TASK_TOOLS.map((t) => t.name)).size).toBe(TASK_TOOLS.length);
    for (const tool of TASK_TOOLS) expect(tool.name).toBe(tool.method.replace(".", "_"));
  });

  it("take their argument schemas from the commands' own zod schemas, not copies", () => {
    const by = Object.fromEntries(TASK_TOOLS.map((t) => [t.method, t.input]));
    expect(by["tasks.create"]).toBe(tasksCreateParams.shape);
    expect(by["tasks.update"]).toBe(tasksUpdateParams.shape);
    expect(by["tasks.list"]).toBe(tasksListParams.shape);
    expect(by["tasks.get"]).toBe(tasksGetParams.shape);
    expect(by["tasks.assign"]).toBe(tasksAssignParams.shape);
    expect(by["tasks.block"]).toBe(tasksBlockParams.shape);
    expect(by["tasks.review"]).toBe(tasksReviewParams.shape);
    expect(by["tasks.heartbeat"]).toBe(tasksHeartbeatParams.shape);
    expect(by["tasks.submit"]).toBe(tasksSubmitParams.shape);
    for (const m of ["claim", "start", "unblock", "release", "reopen", "cancel"]) {
      expect(by[`tasks.${m}`], m).toBe(taskVersionParams.shape);
    }
  });

  it("advertises JSON schemas derived from them", async () => {
    const s = await setup();
    const client = await connect(s.url, s.agent.access_token);
    const { tools } = await client.listTools();
    const create = tools.find((t) => t.name === "tasks_create")!;
    expect(create.inputSchema.required).toEqual(expect.arrayContaining(["title", "requirements"]));
    expect(Object.keys(create.inputSchema.properties!)).toEqual(
      expect.arrayContaining(["title", "requirements", "priority", "idempotency_key"]),
    );
    const claim = tools.find((t) => t.name === "tasks_claim")!;
    expect(claim.inputSchema.required).toEqual(
      expect.arrayContaining(["task_id", "expected_version"]),
    );
    expect(Object.keys(tools.find((t) => t.name === "tasks_get")!.inputSchema.properties!)).toEqual(
      ["task_id"], // reads take no idempotency key
    );
  });

  it("run a task from creation to done through the dispatcher, as the agent", async () => {
    const s = await setup();
    const agent = await connect(s.url, s.agent.access_token);
    const owner = await connect(s.url, s.owner.access_token);

    const created = await call(agent, "tasks_create", {
      title: "Write docs",
      requirements: ["A README exists"],
    });
    expect(created.isError).toBe(false);
    const id = created.body.id as string;
    const claimed = await call(agent, "tasks_claim", { task_id: id, expected_version: 1 });
    expect(claimed.body).toMatchObject({ status: "CLAIMED", owner_id: s.agentId });
    const started = await call(agent, "tasks_start", { task_id: id, expected_version: 2 });
    expect(started.body.status).toBe("IN_PROGRESS");
    const beat = await call(agent, "tasks_heartbeat", { task_id: id });
    expect(beat.body.task_id).toBe(id);
    const submitted = await call(agent, "tasks_submit", { task_id: id, expected_version: 3 });
    expect(submitted.body.status).toBe("REVIEW");

    const got = await call(agent, "tasks_get", { task_id: id });
    expect(got.body).toBeDefined();
    const listed = await call(agent, "tasks_list", { status: ["REVIEW"] });
    expect(JSON.stringify(listed.body)).toContain(id);

    // The owner is the lead here; the agent can't approve its own task, the lead can.
    const mine = await call(agent, "tasks_review", {
      task_id: id,
      expected_version: 4,
      verdict: "approve",
    });
    expect(mine.isError).toBe(true);
    expect(mine.body.error.code).toBe("FORBIDDEN");
    const approved = await call(owner, "tasks_review", {
      task_id: id,
      expected_version: 4,
      verdict: "approve",
    });
    expect(approved.body.status).toBe("DONE");
  });

  it("report a stale version as a tool error carrying the current task", async () => {
    const s = await setup();
    const agent = await connect(s.url, s.agent.access_token);
    const created = await call(agent, "tasks_create", { title: "T", requirements: ["r"] });
    const stale = await call(agent, "tasks_claim", {
      task_id: created.body.id,
      expected_version: 9,
    });
    expect(stale.isError).toBe(true);
    expect(stale.body.error.code).toBe("CONFLICT_VERSION");
    expect(stale.body.error.details.current.id).toBe(created.body.id);
  });

  it("a retry with the same idempotency_key doesn't create a second task", async () => {
    const s = await setup();
    const agent = await connect(s.url, s.agent.access_token);
    const args = { title: "Once", requirements: ["r"], idempotency_key: "retry-1" };
    const a = await call(agent, "tasks_create", args);
    const b = await call(agent, "tasks_create", args);
    expect(b.body.id).toBe(a.body.id);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM tasks WHERE room_id = $1 AND title = 'Once'",
      [s.room],
    );
    expect(rows[0].n).toBe(1);
  });
});
