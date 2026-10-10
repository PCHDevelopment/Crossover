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
const TEST_PLUGIN_IMAGE = `busybox:1.36.1-musl@sha256:${"a".repeat(64)}`;
const invoked: ToolInvocation[] = [];
let gate: Promise<void> | undefined;
const hung: (() => void)[] = [];

const runner: ToolRunner = {
  async run(invocation): Promise<ToolOutput> {
    invoked.push(invocation);
    const args = invocation.args as Record<string, unknown>;
    if (invocation.tool === "github.read_repository" && args["repo"] === "acme/large")
      return { result: { content: "x".repeat(240 * 1024) } };
    if (args["title"] === "slow") await gate;
    if (args["title"] === "hang" || args["url"] === "hang")
      await new Promise<void>((resolve) => hung.push(resolve));
    if (args["title"] === "boom")
      throw new ToolProviderError("GitHub is down", { retryable: true });
    if (args["title"] === "rate-limited")
      throw new ToolProviderError("GitHub rate limit reached", {
        retryable: true,
        code: "RATE_LIMITED",
        details: { provider: "github", provider_code: "rate_limited", retry_after: 12 },
      });
    if (args["title"] === "weird") throw new Error("socket hang up, token tok_leaky_secret");
    return { result: { ok: true, tool: invocation.tool } };
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
    execution: {
      image: TEST_PLUGIN_IMAGE,
      command: ["run"],
      egressHosts: [],
      maxOutputBytes: 256 * 1024,
    },
  });
  r.register({
    name: "github.create_pull_request",
    description: "Open a pull request",
    capability: "github.create_pull_request",
    tier: 2,
    input: z.object({ repo: z.string(), title: z.string() }),
    scope: (a) => a.repo,
    normalizeScope: (scope) => scope.toLowerCase(),
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
  for (const release of hung) release();
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

  it("a tool whose capability isn't held is FORBIDDEN, the same answer an unknown tool gets, recorded as capability.denied, and nothing runs", async () => {
    const r = await newRoom();
    const before = invoked.length;
    const res = await r.invoke("github.create_pull_request", { repo: "acme/widgets", title: "x" });
    expect(res.statusCode).toBe(403);
    const unknown = await r.invoke("nope.nothing", { repo: "acme/widgets", title: "x" });
    expect(unknown.json()).toEqual(res.json()); // same code, message and details: no oracle for which tools exist
    expect(JSON.stringify(res.json())).not.toContain("github.create_pull_request");
    expect(invoked.length).toBe(before);
    const denied = await r.events("capability.denied");
    expect(denied.length).toBe(1); // the held-by-nobody tool is recorded, the unknown one isn't
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
      provenance: { author_kind: "SYSTEM", trust: "external" },
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
      trust: "external",
    });
    expect(JSON.stringify([started, finished])).not.toContain("Ship it"); // no arguments in the ledger
  });

  it("a tier 0 tool leaves no tool events; every tool result is labeled external", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.read_repository"));
    await ok(await r.grant("browser.navigate"));
    await ok(await r.invoke("github.read_repository", { repo: "acme/widgets" }));
    expect(await r.events("tool.invoked")).toEqual([]);
    const page = await ok(await r.invoke("browser.navigate", { url: "https://example.com" }));
    expect(page.response.provenance).toMatchObject({ trust: "external" });
  });

  it("allows repository content within the fixed 256 KiB result limit", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.read_repository:acme/large"));
    const content = await ok(await r.invoke("github.read_repository", { repo: "acme/large" }));
    expect(content.response.result.content).toHaveLength(240 * 1024);
    expect(content.response.provenance).toMatchObject({ trust: "external" });
  });

  it("staging deploys are Tier 2; production requires an owner grant and records the denial", async () => {
    const r = await newRoom();
    const denied = await r.invoke("aws.deploy_lambda", { function: "staging-api" });
    expect(denied.statusCode).toBe(403);
    const stagingGrant = await r.grant("aws.deploy_lambda:staging-*");
    const stagingGrantResult = await ok(stagingGrant);
    expect(stagingGrantResult.response.tier).toBe(2);
    await ok(await r.invoke("aws.deploy_lambda", { function: "staging-api" }));
    expect((await r.events("tool.invoked")).at(-1)!.payload).toMatchObject({
      capability: "aws.deploy_lambda:staging-api",
      tier: 2,
    });
    const prod = await r.invoke("aws.deploy_lambda", { function: "prod-api" });
    expect(prod.statusCode).toBe(403);
    expect((await r.events("capability.denied")).at(-1)!.payload).toMatchObject({
      missing_capability: "aws.deploy_lambda:prod-api",
    });
    await ok(await r.grant("aws.deploy_lambda:prod-*", { expires_at: tomorrow() }));
    await ok(await r.invoke("aws.deploy_lambda", { function: "prod-api" }));
    expect((await r.events("tool.invoked")).at(-1)!.payload).toMatchObject({
      capability: "aws.deploy_lambda:prod-api",
      tier: 3,
    });
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

  it("preserves the GitHub rate-limit code and retry delay from the worker", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.create_pull_request:acme/widgets"));
    const limited = await r.invoke("github.create_pull_request", {
      repo: "acme/widgets",
      title: "rate-limited",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      details: { provider: "github", provider_code: "rate_limited", retry_after: 12 },
    });
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

  it("bad arguments are VALIDATION for a holder; an unknown tool is the same FORBIDDEN as one you don't hold, and the arguments of a tool you don't hold aren't described", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.read_repository"));
    expect((await r.invoke("github.read_repository", { repo: 5 })).statusCode).toBe(400);
    const unknown = await r.invoke("nope.nothing", {});
    expect(unknown.statusCode).toBe(403);
    const unheld = await r.invoke("browser.navigate", { nonsense: true });
    expect(unheld.statusCode).toBe(403);
    expect(unheld.body).not.toContain("issues");
    expect(unheld.json()).toEqual(unknown.json());
  });
});

/** Exactly-once (review of T1201): the key is claimed before the effect, and the outcome kept whatever happens next. */
describe("tools run exactly once", () => {
  const send = (r: Awaited<ReturnType<typeof newRoom>>, request: unknown) =>
    post(`/v1/rooms/${r.roomId}/commands`, request, r.dev);
  const pr = (title: string, repo = "acme/widgets") =>
    envelope("tools.invoke", { tool: "github.create_pull_request", args: { repo, title } });
  const waitRuns = async (count: number) => {
    for (let i = 0; i < 100 && invoked.length < count; i++)
      await new Promise((res) => setTimeout(res, 20));
  };

  it("the same key twice at once runs the tool once: the second is 'in progress', then replays", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.create_pull_request:acme/widgets"));
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const before = invoked.length;
    const request = pr("slow");
    const first = send(r, request);
    await waitRuns(before + 1);
    const second = await send(r, request);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({
      retryable: true,
      details: { reason: "in_progress" },
    });
    release();
    expect((await first).statusCode).toBe(200);
    const third = await ok(await send(r, request));
    expect(third.replayed).toBe(true);
    expect(invoked.length).toBe(before + 1);
  });

  it("another request under a used key is the key-reuse error and runs nothing", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.create_pull_request:acme/widgets"));
    const request = pr("first");
    await ok(await send(r, request));
    const before = invoked.length;
    const other = await send(r, { ...pr("second"), idempotency_key: request.idempotency_key });
    expect(other.statusCode).toBe(400);
    expect(invoked.length).toBe(before);
  });

  it("a timeout of a tool that isn't idempotent is not retryable (outcome unknown), kept under the key, and a retry doesn't run it again", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.create_pull_request:acme/widgets"));
    const request = pr("hang");
    const before = invoked.length;
    const timedOut = await send(r, request);
    expect(timedOut.statusCode).toBe(503);
    expect(timedOut.json().error).toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: false,
      details: { outcome: "unknown" },
    });
    const retried = await send(r, request);
    expect(retried.statusCode).toBe(503);
    expect(retried.json().error.details.outcome).toBe("unknown");
    expect(invoked.length).toBe(before + 1);
  });

  it("a timeout of an idempotent tool may be retried: the key is released and the retry runs it again", async () => {
    const r = await newRoom();
    await ok(await r.grant("browser.navigate"));
    const request = envelope("tools.invoke", { tool: "browser.navigate", args: { url: "hang" } });
    const before = invoked.length;
    const first = await send(r, request);
    expect(first.statusCode).toBe(503);
    expect(first.json().error).toMatchObject({ retryable: true });
    expect(first.json().error.details.outcome).toBeUndefined();
    const second = await send(r, request);
    expect(second.statusCode).toBe(503);
    expect(invoked.length).toBe(before + 2);
  });

  it("a grant revoked while the tool runs doesn't lose its result: it is recorded and a retry replays it", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.create_pull_request:acme/widgets"));
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const before = invoked.length;
    const request = pr("slow");
    const running = send(r, request);
    await waitRuns(before + 1);
    await ok(
      await r.call(r.owner, "capabilities.revoke", {
        participant_id: r.devId,
        capability: "github.create_pull_request:acme/widgets",
      }),
    );
    release();
    const done = await running;
    expect(done.statusCode, done.body).toBe(200);
    expect((await r.events("tool.completed")).length).toBe(1);
    const retry = await ok(await send(r, request)); // its own result, replayed; nothing runs
    expect(retry.replayed).toBe(true);
    expect(invoked.length).toBe(before + 1);
  });

  it("an approved invocation doesn't run on approval: the requester's retry with the same key runs it once", async () => {
    const r = await newRoom();
    await ok(
      await r.call(r.owner, "capabilities.grant", {
        participant_id: r.devId,
        capability: "github.create_pull_request:acme/widgets",
        requires_approval: true,
      }),
    );
    const request = pr("gated");
    const before = invoked.length;
    const waiting = await send(r, request);
    expect(waiting.statusCode).toBe(202);
    const approvalId = waiting.json().error.details.approval_id as string;
    expect(invoked.length).toBe(before);

    const decided = await ok(
      await r.call(r.owner, "approvals.decide", { approval_id: approvalId, decision: "approve" }),
    );
    expect(decided.response.approval.status).toBe("APPROVED");
    expect(decided.response.result).toBeUndefined();
    expect(invoked.length).toBe(before); // not run inside the approver's transaction

    const ran = await ok(await send(r, request));
    expect(ran.replayed).toBe(false);
    expect(invoked.length).toBe(before + 1);
    expect((await r.events("tool.invoked")).length).toBe(1);
    const again = await ok(await send(r, request));
    expect(again.replayed).toBe(true);
    expect(invoked.length).toBe(before + 1);

    // The approval is for that request only: another invocation waits for its own.
    const next = await send(r, pr("another"));
    expect(next.statusCode).toBe(202);
  });

  it("tools.list shows gated tools with requires_approval and never answers a read with APPROVAL_REQUIRED", async () => {
    const r = await newRoom();
    const gated = (capability: string) =>
      r.call(r.owner, "capabilities.grant", {
        participant_id: r.devId,
        capability,
        requires_approval: true,
      });
    await ok(await gated("github.create_pull_request")); // unscoped
    await ok(await gated("github.read_repository:acme/widgets")); // scoped
    await ok(await r.grant("browser.navigate"));
    const listed = (await ok(await r.call(r.dev, "tools.list"))).response.tools as {
      name: string;
      requires_approval: boolean;
    }[];
    expect(listed.map((t) => [t.name, t.requires_approval])).toEqual([
      ["browser.navigate", false],
      ["github.create_pull_request", true],
      ["github.read_repository", true],
    ]);
  });

  it("scopes are canonical: traversal and encoding don't slip past a wildcard grant, and the runner gets the canonical scope", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.create_pull_request:acme/*"));
    const before = invoked.length;
    for (const repo of [
      "acme/../evil/repo",
      "acme/./x",
      "acme//x",
      "acme/x/..",
      "acme/%2e%2e/evil",
      "acme/x?y=1",
      "acme/x#frag",
      "acme\\..\\evil",
      "acme/x\u0000y",
      "acme/*",
      `acme/${"a".repeat(300)}`,
    ]) {
      const res = await r.invoke("github.create_pull_request", { repo, title: "t" });
      expect(res.statusCode, repo).toBe(400);
    }
    expect(invoked.length).toBe(before);
    await ok(await r.invoke("github.create_pull_request", { repo: "ACME/Widgets", title: "t" }));
    expect(invoked.at(-1)).toMatchObject({
      scope: "acme/widgets",
      capability: "github.create_pull_request:acme/widgets",
    });
  });
});

/** The review's second round (O1): probes that each reproduced a lost or repeated side effect. */
describe("tools: keys, freezes and stale claims", () => {
  const send = (r: Awaited<ReturnType<typeof newRoom>>, request: unknown) =>
    post(`/v1/rooms/${r.roomId}/commands`, request, r.dev);
  const pr = (title: string) =>
    envelope("tools.invoke", {
      tool: "github.create_pull_request",
      args: { repo: "acme/widgets", title },
    });

  it("a key already used by another command doesn't run the tool and then complain", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.create_pull_request:acme/widgets"));
    const key = "shared-key";
    await ok(await send(r, { ...envelope("messages.send", { body: "hi" }), idempotency_key: key }));
    const before = invoked.length;
    const clash = await send(r, { ...pr("clash"), idempotency_key: key });
    expect(clash.statusCode).toBe(400);
    expect(invoked.length).toBe(before); // nothing was created
  });

  it("a room frozen while the tool runs: the run is recorded, and after the resume the key holder gets it, even if the grant was revoked meanwhile", async () => {
    const r = await newRoom();
    await ok(await r.grant("github.create_pull_request:acme/widgets"));
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const before = invoked.length;
    const request = pr("slow");
    const running = send(r, request);
    for (let i = 0; i < 100 && invoked.length === before; i++)
      await new Promise((res) => setTimeout(res, 20));
    await ok(await r.call(r.owner, "room.freeze", {}));
    release();
    const first = await running;
    expect(first.statusCode).not.toBe(200); // the frozen room can't take the answer…
    expect(invoked.length).toBe(before + 1); // …but the tool ran once
    await ok(await r.call(r.owner, "room.resume", {}));
    await ok(
      await r.call(r.owner, "capabilities.revoke", {
        participant_id: r.devId,
        capability: "github.create_pull_request:acme/widgets",
      }),
    );
    // Five retries at once (a client that gave up waiting, five times): one event, one result.
    const retries = await Promise.all(Array.from({ length: 5 }, () => send(r, request)));
    for (const res of retries) expect(res.statusCode, res.body).toBe(200);
    const retry = retries[0]!.json();
    expect(retry.response.result).toMatchObject({ ok: true });
    expect(invoked.length).toBe(before + 1);
    expect((await r.events("tool.completed")).length).toBe(1); // logged once, whichever attempt got to
    expect((await ok(await send(r, request))).replayed).toBe(true);
  });

  it("a claim left behind by a lost process: an idempotent tool is taken over, any other reads as 'outcome unknown' and logs tool.failed", async () => {
    const r = await newRoom();
    await ok(await r.grant("browser.navigate"));
    await ok(await r.grant("github.create_pull_request:acme/widgets"));
    const age = async () => {
      await db.pool.query(
        `UPDATE tool_invocations SET outcome = NULL, events_logged = false,
           claimed_at = clock_timestamp() - interval '10 minutes'
         WHERE room_id = $1`,
        [r.roomId],
      );
      await db.pool.query("DELETE FROM idempotency_keys WHERE participant_id = $1", [r.devId]);
    };
    const page = envelope("tools.invoke", {
      tool: "browser.navigate",
      args: { url: "https://example.com" },
    });
    await ok(await send(r, page));
    const before = invoked.length;
    await age();
    const again = await ok(await send(r, page));
    expect(again.response.result).toMatchObject({ ok: true });
    expect(invoked.length).toBe(before + 1); // taken over and run again: it is safe to

    const request = pr("lost");
    await ok(await send(r, request));
    const ran = invoked.length;
    await age();
    const unknown = await send(r, request);
    expect(unknown.statusCode).toBe(503);
    expect(unknown.json().error).toMatchObject({
      retryable: false,
      details: { outcome: "unknown" },
    });
    expect(invoked.length).toBe(ran); // not run again
    expect((await r.events("tool.failed")).length).toBeGreaterThanOrEqual(1);
  });
});
