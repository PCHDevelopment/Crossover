import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { withTransaction } from "@crossover/db";
import {
  Dispatcher,
  findOrCreateUser,
  issueTokens,
  registerCapabilityCommands,
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
import { BASE_TOOLS, MCP_TOOLS } from "./tools.js";
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
