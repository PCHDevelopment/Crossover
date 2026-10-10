import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { MCP_TOOLS } from "@crossover/mcp";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

/**
 * Egress visibility conformance (§34.5, T1301): visibility is decided in one layer, applied at
 * every egress. This composes the real server, lets participant A be denied a path, and reads
 * everything a participant can read as participant B, asserting that the path never reaches B.
 * It enumerates the surfaces from the registries (every read command, every MCP read tool, the
 * WebSocket stream), so a new surface is covered without editing this file; a read that needs
 * arguments declares them with `view_probe`.
 */

const SECRET = "secrets/key.pem";
const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";

let db: TestDatabase;
let root: string;
let server: CrossoverServer;
let serial = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-egress-e2e-"));
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl,
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `egress-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
  };
  server = await composeServer(config, { pool: db.pool });
});

afterAll(async () => {
  await server?.close();
  await db?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

const envelope = (method: string, params: Record<string, unknown> = {}, key = true) => ({
  id: newId("cmd"),
  method,
  params,
  ...(key ? { idempotency_key: `egress-${++serial}` } : {}),
});

const post = (url: string, payload: unknown, token?: string) =>
  server.app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: JSON.stringify(payload),
  });

async function ok(res: Awaited<ReturnType<typeof post>>, status = 200) {
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

interface Fixture {
  roomId: string;
  owner: string;
  a: { token: string; id: string };
  b: { token: string; id: string };
  command: (
    token: string,
    method: string,
    params?: Record<string, unknown>,
  ) => ReturnType<typeof post>;
}

async function joinRoom(roomId: string, owner: string, name: string) {
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
        name,
        operator: { name: "Peter", contact: "peter@example.com" },
        vendor: "Anthropic",
        model: "test-model",
        client: "mcp",
        client_version: "1.0.0",
        description: "Egress test participant",
      },
    }),
    201,
  );
  return {
    token: joined.tokens.access_token as string,
    id: joined.participant_id as string,
  };
}

/** A room where A has been denied `secrets/**` and has tried to write it, and B is a bystander. */
async function fixture(): Promise<Fixture> {
  const login = await ok(
    await post("/v1/auth/dev-login", { subject: `egress-${newId("usr")}`, display_name: "Owner" }),
  );
  const created = await ok(
    await post(
      "/v1/commands",
      envelope("room.create", {
        slug: `egress-${++serial}`,
        name: "Egress",
        objective: "Visibility",
      }),
      login.session_token,
    ),
  );
  const roomId = created.response.room.id as string;
  const session = await ok(await post(`/v1/rooms/${roomId}/session`, {}, login.session_token));
  const owner = session.tokens.access_token as string;
  const command = (token: string, method: string, params: Record<string, unknown> = {}) =>
    post(`/v1/rooms/${roomId}/commands`, envelope(method, params, false), token);
  const mutate = (token: string, method: string, params: Record<string, unknown>) =>
    post(`/v1/rooms/${roomId}/commands`, envelope(method, params), token);

  const a = await joinRoom(roomId, owner, "Agent-A");
  const b = await joinRoom(roomId, owner, "Agent-B");

  // B puts a file in the workspace. The secret path itself never exists there: the only trace of
  // it is the denial event, so seeing it anywhere is a leak of that event.
  await ok(
    await mutate(b.token, "workspace.apply_changeset", {
      source: "API",
      message: "Seed",
      base_workspace_revision: 0,
      operations: [{ type: "create", path: "docs/readme.md", content: "# Egress\n" }],
    }),
  );
  await ok(
    await mutate(owner, "capabilities.revoke", {
      participant_id: a.id,
      capability: "workspace.write:secrets/**",
    }),
  );
  // A's attempt is denied, and the denial (with the path) lands in the ledger.
  const denied = await mutate(a.token, "workspace.apply_changeset", {
    source: "API",
    message: "Try it",
    base_workspace_revision: 1,
    operations: [{ type: "create", path: SECRET, content: "changed\n" }],
  });
  expect(denied.statusCode, denied.body).toBe(403);
  // B may not read secrets/** either, and A announces it is about to edit the secret path:
  // an intent that must stay out of B's reads too.
  await ok(
    await mutate(owner, "capabilities.revoke", {
      participant_id: b.id,
      capability: "workspace.read:secrets/**",
    }),
  );
  await ok(await command(a.token, "presence.set_intent", { paths: [SECRET] }));
  return { roomId, owner, a, b, command };
}

/** Arguments for reads that need some; new reads declare `view_probe` instead of adding here. */
const KNOWN_PROBES: Record<string, Record<string, unknown>> = {
  "workspace.read": { path: "docs/readme.md" },
  "workspace.diff": { from_revision: 0, to_revision: 1 },
  "workspace.blame": { path: "docs/readme.md" },
  "workspace.search": { query: "Egress" },
  "conflicts.get": { conflict_id: "conf_probe" },
  "workspace.health.get": { run_id: "health_probe" },
  "tasks.get": { task_id: "task_probe" },
  "decisions.get": { decision_id: "dec_probe" },
  "memory.get": { key: "probe/key" },
  "memory.history": { key: "probe/key" },
  "tasks.heartbeat": { task_id: "task_probe" },
};

describe("egress visibility conformance (§34.5)", () => {
  it("the surfaces under test are the registered ones: every read declares its view", () => {
    const reads = server.dispatcher.commandInfo().filter((c) => !c.mutating);
    expect(reads.length).toBeGreaterThan(15);
    for (const c of reads) {
      expect(["participant", "own", "none"], c.method).toContain(c.view);
      if (c.view === "none") expect(c.view_reason, c.method).toBeTruthy();
    }
    // A mutating command declares none.
    for (const c of server.dispatcher.commandInfo().filter((c) => c.mutating)) {
      expect(c.view, c.method).toBeUndefined();
    }
  });

  it("every read command: B never receives A's denied path, and the owner does (control)", async () => {
    const f = await fixture();
    const reads = server.dispatcher.commandInfo().filter((c) => !c.mutating);
    const problems: string[] = [];
    let ownerSaw = false;
    for (const c of reads) {
      const params = KNOWN_PROBES[c.method] ?? c.view_probe ?? {};
      const asB = await f.command(f.b.token, c.method, params);
      if (asB.body.includes(SECRET)) {
        problems.push(`${c.method} (declared view: ${c.view}) returned ${SECRET} to B`);
      }
      if (c.view === "participant") {
        // A participant-view read must really have run, not been turned away for its arguments.
        const code = asB.statusCode === 200 ? "ok" : (asB.json().error?.code as string);
        if (code !== "ok" && code !== "NOT_FOUND") {
          problems.push(
            `${c.method} answered ${asB.statusCode} ${code} to its probe: declare view_probe`,
          );
        }
      }
      if (c.method === "room.events.list") {
        const asOwner = await f.command(f.owner, c.method, params);
        ownerSaw = asOwner.body.includes(SECRET);
      }
    }
    expect(problems).toEqual([]);
    expect(ownerSaw, "control: the owner sees the denied path in room.events.list").toBe(true);
  });

  it("the WebSocket stream, backfill and live: B never receives it, the owner does (control)", async () => {
    const f = await fixture();
    const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
    const open = async (token: string) => {
      const sock = new WebSocket(`${address.replace("http", "ws")}/v1/rooms/${f.roomId}/ws`);
      const frames: string[] = [];
      sock.onmessage = (m) => frames.push(String(m.data));
      await new Promise((resolve, reject) => {
        sock.onopen = resolve;
        sock.onerror = reject;
      });
      sock.send(
        JSON.stringify({
          type: "hello",
          protocol_version: 1,
          client: "e2e",
          client_version: "1",
          token,
        }),
      );
      const until = async (done: () => boolean, label: string) => {
        for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 50));
        expect(done(), `${label}: ${frames.join("\n").slice(0, 400)}`).toBe(true);
      };
      await until(() => frames.some((fr) => fr.includes('"hello_ok"')), "hello");
      sock.send(JSON.stringify({ type: "subscribe", after: 0, profile: "all" }));
      await until(() => frames.some((fr) => fr.includes('"subscribed"')), "subscribed");
      return { sock, frames, until };
    };
    const asB = await open(f.b.token);
    const asOwner = await open(f.owner);
    const denials = (frames: string[]) => frames.filter((fr) => fr.includes("capability.denied"));
    await asB.until(() => denials(asB.frames).length >= 1, "B's backfill");
    await asOwner.until(() => denials(asOwner.frames).length >= 1, "the owner's backfill");

    // And live: A is denied again with everyone subscribed.
    const again = await post(
      `/v1/rooms/${f.roomId}/commands`,
      envelope("workspace.apply_changeset", {
        source: "API",
        message: "Again",
        base_workspace_revision: 1,
        operations: [{ type: "create", path: SECRET, content: "again\n" }],
      }),
      f.a.token,
    );
    expect(again.statusCode, again.body).toBe(403);
    await asB.until(() => denials(asB.frames).length >= 2, "B's live denial");
    await asOwner.until(() => denials(asOwner.frames).length >= 2, "the owner's live denial");

    expect(asB.frames.join("\n").includes(SECRET), "WebSocket stream leaked the path to B").toBe(
      false,
    );
    expect(asOwner.frames.join("\n").includes(SECRET), "control: the owner's stream shows it").toBe(
      true,
    );
    asB.sock.close();
    asOwner.sock.close();
  });

  it("edit intents: a reader denied a path never sees it in someone else's intent (scoped reader)", async () => {
    const f = await fixture();
    const set = (token: string, params: Record<string, unknown>) =>
      post(`/v1/rooms/${f.roomId}/commands`, envelope("presence.set_intent", params, false), token);
    // The fixture already denies B secrets/** and has A announcing an edit of the secret.
    await ok(
      await set(f.a.token, {
        paths: [SECRET, "docs/readme.md"],
        ranges: [
          { path: SECRET, start_line: 1, end_line: 2 },
          { path: "docs/readme.md", start_line: 1, end_line: 1 },
        ],
      }),
    );
    const list = async (token: string) =>
      (await ok(await f.command(token, "presence.list_intents"))).response.intents as {
        participant_id: string;
        paths: string[];
        ranges: { path: string }[];
      }[];

    const asB = await list(f.b.token);
    expect(JSON.stringify(asB)).not.toContain(SECRET);
    expect(asB).toHaveLength(1);
    expect(asB[0]).toMatchObject({ participant_id: f.a.id, paths: ["docs/readme.md"] });
    expect(asB[0]!.ranges.map((r) => r.path)).toEqual(["docs/readme.md"]);

    // Control: a reader who may read secrets/** sees both.
    expect((await list(f.owner))[0]!.paths).toEqual([SECRET, "docs/readme.md"]);

    // An intent only on a path B can't read is omitted whole.
    await ok(await set(f.a.token, { paths: [SECRET] }));
    expect(await list(f.b.token)).toEqual([]);
    expect((await list(f.owner))[0]!.paths).toEqual([SECRET]);
  });

  it("every MCP read tool: B never receives it, and each tool is a registered read command", async () => {
    const f = await fixture();
    const byMethod = new Map(server.dispatcher.commandInfo().map((c) => [c.method, c]));
    const problems: string[] = [];
    let rpcId = 0;
    for (const tool of MCP_TOOLS.filter((t) => !t.mutating)) {
      const command = byMethod.get(tool.method);
      if (!command || command.mutating) {
        problems.push(`MCP tool ${tool.name} wraps ${tool.method}, which isn't a registered read`);
        continue;
      }
      const args = KNOWN_PROBES[tool.method] ?? command.view_probe ?? {};
      const res = await post(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: ++rpcId,
          method: "tools/call",
          params: { name: tool.name, arguments: args },
        },
        f.b.token,
      );
      if (res.body.includes(SECRET)) {
        problems.push(`MCP tool ${tool.name} (${tool.method}) returned ${SECRET} to B`);
      }
    }
    expect(problems).toEqual([]);
  });
});
