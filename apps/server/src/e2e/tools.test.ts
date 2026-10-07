import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import {
  ToolProviderError,
  ToolRegistry,
  type EventPublisher,
  type ToolInvocation,
  type ToolOutput,
  type ToolRunner,
} from "@crossover/kernel";
import { tierOf } from "@crossover/policy";
import { z } from "zod";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

/** The tool registry (T1201) through the real server: the real policy, the prepare phase and the ledger. */

let db: TestDatabase;
let root: string;
let server: CrossoverServer;
let serial = 0;
const invoked: ToolInvocation[] = [];
let gate: Promise<void> | undefined;

const runner: ToolRunner = {
  async run(invocation): Promise<ToolOutput> {
    invoked.push(invocation);
    const args = invocation.args as Record<string, unknown>;
    if (args["title"] === "slow") await gate;
    if (args["title"] === "boom")
      throw new ToolProviderError("GitHub is down", { retryable: true });
    if (args["title"] === "weird") throw new Error("socket hang up, token tok_leaky_secret");
    return {
      result: { ok: true, tool: invocation.tool },
      external: invocation.tool === "browser.navigate",
    };
  },
};

function registry() {
  const r = new ToolRegistry({ tierOf });
  r.register({
    name: "github.read_repository",
    description: "Read a repository",
    capability: "github.read_repository",
    tier: 0,
    input: z.object({ repo: z.string() }),
    scope: (a) => a.repo,
    idempotent: true,
  });
  r.register({
    name: "github.create_pull_request",
    description: "Open a pull request",
    capability: "github.create_pull_request",
    tier: 2,
    input: z.object({ repo: z.string(), title: z.string() }),
    scope: (a) => a.repo,
    idempotent: false,
  });
  r.register({
    name: "browser.navigate",
    description: "Load a page",
    capability: "browser.navigate",
    tier: 2,
    input: z.object({ url: z.string() }),
    idempotent: true,
  });
  r.register({
    name: "aws.deploy_lambda",
    description: "Deploy a function",
    capability: "aws.deploy_lambda",
    tier: 3,
    input: z.object({ function: z.string() }),
    scope: (a) => a.function,
    idempotent: false,
  });
  return r;
}

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-tools-e2e-"));
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `tools-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
  };
  const publisher: EventPublisher = { publish: async () => undefined };
  server = await composeServer(config, {
    pool: db.pool,
    publisher,
    tools: { registry: registry(), runner, timeoutMs: 2_000 },
  });
});

afterAll(async () => {
  await server?.close();
  await db?.drop();
  await rm(root, { recursive: true, force: true });
});

const envelope = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `tools-e2e-${++serial}`,
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

async function newRoom() {
  const login = await ok(
    await post("/v1/auth/dev-login", { subject: `tool-${newId("usr")}`, display_name: "Owner" }),
  );
  const created = await ok(
    await post(
      "/v1/commands",
      envelope("room.create", { slug: `tool-${++serial}`, name: "Tools", objective: "Use tools" }),
      login.session_token,
    ),
  );
  const roomId = created.response.room.id as string;
  const owner = (await ok(await post(`/v1/rooms/${roomId}/session`, {}, login.session_token)))
    .tokens.access_token as string;
  const invite = await ok(
    await post(
      `/v1/rooms/${roomId}/commands`,
      envelope("room.invite", { role: "DEVELOPER" }),
      owner,
    ),
  );
  const joined = await ok(
    await post(`/v1/rooms/${roomId}/join`, {
      token: invite.one_time.token,
      manifest: {
        name: "Dev",
        operator: { name: "P", contact: "p@example.com" },
        vendor: "Anthropic",
        model: "m",
        client: "mcp",
        client_version: "1",
        description: "d",
      },
    }),
    201,
  );
  const dev = joined.tokens.access_token as string;
  const devId = (
    await db.pool.query("SELECT id FROM participants WHERE room_id = $1 AND kind = 'AGENT'", [
      roomId,
    ])
  ).rows[0].id as string;
  const call = (token: string, method: string, params: Record<string, unknown> = {}) =>
    post(`/v1/rooms/${roomId}/commands`, envelope(method, params), token);
  const grant = (capability: string, extra: Record<string, unknown> = {}) =>
    call(owner, "capabilities.grant", { participant_id: devId, capability, ...extra });
  const events = async (type: string) =>
    (
      await db.pool.query(
        "SELECT actor_id, payload FROM events WHERE room_id = $1 AND type = $2 ORDER BY sequence",
        [roomId, type],
      )
    ).rows;
  const invoke = (tool: string, args: Record<string, unknown>) =>
    call(dev, "tools.invoke", { tool, args });
  return { roomId, owner, dev, devId, call, grant, events, invoke };
}

const tomorrow = () => new Date(Date.now() + 6 * 3_600_000).toISOString();

describe("tools over HTTP", () => {
  it("tools.list shows only the tools the caller holds the capability for, for any scope of it", async () => {
    const r = await newRoom();
    expect((await ok(await r.call(r.dev, "tools.list"))).response.tools).toEqual([]);
    await ok(await r.grant("github.read_repository:acme/widgets"));
    const listed = (await ok(await r.call(r.dev, "tools.list"))).response.tools as {
      name: string;
      tier: number;
      input_schema: { type: string };
    }[];
    expect(listed.map((t) => [t.name, t.tier])).toEqual([["github.read_repository", 0]]);
    expect(listed[0]!.input_schema.type).toBe("object");
  });

  it("a tool whose capability isn't held is FORBIDDEN naming it, recorded as capability.denied, and nothing runs", async () => {
    const r = await newRoom();
    const before = invoked.length;
    const res = await r.invoke("github.create_pull_request", { repo: "acme/widgets", title: "x" });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json().error.details)).toContain("github.create_pull_request");
    expect(invoked.length).toBe(before);
    const denied = await r.events("capability.denied");
    expect(denied.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(denied[0]!.payload)).toContain("github.create_pull_request");
  });

  it("a scope outside the grant is FORBIDDEN; inside it runs, and tier 2 is logged without the arguments", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.create_pull_request:acme/widgets"));
    const before = invoked.length;
    const other = await r.invoke("github.create_pull_request", { repo: "acme/other", title: "x" });
    expect(other.statusCode).toBe(403);
    expect(JSON.stringify(other.json().error.details)).toContain("github.create_pull_request");
    expect(invoked.length).toBe(before);

    const done = await ok(
      await r.invoke("github.create_pull_request", { repo: "acme/widgets", title: "Ship it" }),
    );
    expect(done.response).toMatchObject({
      tool: "github.create_pull_request",
      result: { ok: true },
      provenance: { author_kind: "SYSTEM", trust: "system" },
    });
    expect(invoked[invoked.length - 1]).toMatchObject({
      capability: "github.create_pull_request:acme/widgets",
      participant_id: r.devId,
      room_id: r.roomId,
    });
    const [started] = await r.events("tool.invoked");
    const [finished] = await r.events("tool.completed");
    expect(started!.payload).toMatchObject({
      tool: "github.create_pull_request",
      capability: "github.create_pull_request:acme/widgets",
      tier: 2,
    });
    expect(finished!.payload).toMatchObject({
      tool: "github.create_pull_request",
      tier: 2,
      trust: "system",
    });
    expect(JSON.stringify([started, finished])).not.toContain("Ship it"); // no arguments in the ledger
  });

  it("a tier 0 tool leaves no tool events; a page's content is labeled external", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.read_repository"));
    await ok(await r.grant("browser.navigate"));
    await ok(await r.invoke("github.read_repository", { repo: "acme/widgets" }));
    expect(await r.events("tool.invoked")).toEqual([]);
    const page = await ok(await r.invoke("browser.navigate", { url: "https://example.com" }));
    expect(page.response.provenance).toMatchObject({ trust: "external" });
  });

  it("tier 3 needs the owner's time-limited grant, and nothing in a role bundle gives it", async () => {
    const r = await newRoom();
    const denied = await r.invoke("aws.deploy_lambda", { function: "staging-api" });
    expect(denied.statusCode).toBe(403);
    const noExpiry = await r.grant("aws.deploy_lambda:staging-*");
    expect(noExpiry.statusCode).toBe(400);
    await ok(await r.grant("aws.deploy_lambda:staging-*", { expires_at: tomorrow() }));
    await ok(await r.invoke("aws.deploy_lambda", { function: "staging-api" }));
    const prod = await r.invoke("aws.deploy_lambda", { function: "prod-api" });
    expect(prod.statusCode).toBe(403);
    expect((await r.events("tool.invoked")).at(-1)!.payload).toMatchObject({ tier: 3 });
  });

  it("a provider outage is a retryable PROVIDER_UNAVAILABLE, the platform doesn't retry, and nothing a runner throws by accident leaks", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.create_pull_request:acme/widgets"));
    const before = invoked.length;
    const down = await r.invoke("github.create_pull_request", {
      repo: "acme/widgets",
      title: "boom",
    });
    expect(down.statusCode).toBe(503);
    expect(down.json().error).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    expect(invoked.length).toBe(before + 1); // a non-idempotent tool, run exactly once
    expect((await r.events("tool.failed"))[0]!.payload).toMatchObject({
      tool: "github.create_pull_request",
      retryable: true,
    });

    const weird = await r.invoke("github.create_pull_request", {
      repo: "acme/widgets",
      title: "weird",
    });
    expect(weird.statusCode).toBe(503);
    expect(weird.body).not.toContain("tok_leaky_secret");
    expect(weird.json().error.retryable).toBe(false);
  });

  it("the same idempotency key replays the result and doesn't run the tool again", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.create_pull_request:acme/widgets"));
    const request = envelope("tools.invoke", {
      tool: "github.create_pull_request",
      args: { repo: "acme/widgets", title: "once" },
    });
    const before = invoked.length;
    const first = await ok(await post(`/v1/rooms/${r.roomId}/commands`, request, r.dev));
    const second = await ok(await post(`/v1/rooms/${r.roomId}/commands`, request, r.dev));
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(invoked.length).toBe(before + 1);
  });

  it("a slow tool doesn't hold the room: a message posts while it runs", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.create_pull_request:acme/widgets"));
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const before = invoked.length;
    const running = r.invoke("github.create_pull_request", { repo: "acme/widgets", title: "slow" });
    for (let i = 0; i < 100 && invoked.length === before; i++)
      await new Promise((res) => setTimeout(res, 20));
    const posted = await Promise.race([
      r.call(r.owner, "messages.send", { body: "meanwhile" }).then((x) => x.statusCode),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 3_000)),
    ]);
    expect(posted).toBe(200);
    release();
    expect((await running).statusCode).toBe(200);
  });

  it("bad arguments are VALIDATION, an unknown tool is NOT_FOUND", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.read_repository"));
    expect((await r.invoke("github.read_repository", { repo: 5 })).statusCode).toBe(400);
    expect((await r.invoke("nope.nothing", {})).statusCode).toBe(404);
  });
});
