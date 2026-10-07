import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import type { EventPublisher } from "@crossover/kernel";
import { newId, type RoomEvent } from "@crossover/protocol";
import { git, type ExecutionDriver, type SandboxLimits } from "@crossover/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type ComposeOverrides, type CrossoverServer } from "./compose.js";
import { loadConfig, type ServerConfig } from "./config.js";

let db: TestDatabase;
let root: string;
const servers: CrossoverServer[] = [];
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-server-test-"));
});

afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await db.drop();
  await rm(root, { recursive: true, force: true });
});

class RecordingPublisher implements EventPublisher {
  readonly events: RoomEvent[] = [];
  async publish(_roomId: string, events: readonly RoomEvent[]): Promise<void> {
    this.events.push(...events);
  }
}

class RecordingExecutionDriver implements ExecutionDriver {
  readonly stopped: string[] = [];
  readonly destroyed: string[] = [];

  async create({ sandbox_id }: { sandbox_id: string; limits: SandboxLimits }) {
    return { volume_ref: `volume:${sandbox_id}`, container_ref: `container:${sandbox_id}` };
  }
  async start(_input: { sandbox_id: string }): Promise<void> {}
  async stop(input: { sandbox_id: string }): Promise<void> {
    this.stopped.push(input.sandbox_id);
  }
  async destroy(input: { sandbox_id: string }): Promise<void> {
    this.destroyed.push(input.sandbox_id);
  }
}

function config(extra: Partial<ServerConfig> = {}): ServerConfig {
  return {
    databaseUrl: "unused: a pool is passed in",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `node-${++n}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
    ...extra,
  };
}

async function start(
  extra: Partial<ServerConfig> = {},
  publisher = new RecordingPublisher(),
  overrides: Partial<ComposeOverrides> = {},
) {
  const server = await composeServer(config(extra), { pool: db.pool, publisher, ...overrides });
  servers.push(server);
  return { server, publisher };
}

let keyN = 0;
const envelope = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `e2e-${++keyN}`,
});

type App = CrossoverServer["app"];
const post = (app: App, url: string, body: unknown, token?: string) =>
  app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: JSON.stringify(body),
  });

async function ok(res: Awaited<ReturnType<typeof post>>, status = 200) {
  expect(res.statusCode, res.body).toBe(status);
  return res.json();
}

/** The skeleton flow over HTTP, as a person and an agent would drive it. */
async function walkthrough(app: App, withAppliedChange = true) {
  const login = await ok(
    await post(app, "/v1/auth/dev-login", { subject: `peter-${++n}`, display_name: "Peter" }),
  );
  const created = await ok(
    await post(
      app,
      "/v1/commands",
      envelope("room.create", { slug: `alpha-${++n}`, name: "Project Alpha", objective: "Ship" }),
      login.session_token,
    ),
  );
  const roomId = created.response.room.id as string;
  const owner = await ok(await post(app, `/v1/rooms/${roomId}/session`, {}, login.session_token));
  const cmd = (body: unknown, token: string) =>
    post(app, `/v1/rooms/${roomId}/commands`, body, token);

  const invite = await ok(
    await cmd(envelope("room.invite", { role: "DEVELOPER" }), owner.tokens.access_token),
  );
  const agent = await ok(
    await post(app, `/v1/rooms/${roomId}/join`, {
      token: invite.one_time.token,
      manifest: {
        name: "Agent-A",
        operator: { name: "Peter", contact: "peter@example.com" },
        vendor: "Anthropic",
        model: "test-model",
        client: "mcp",
        client_version: "1.0.0",
        description: "Writes TypeScript",
      },
    }),
    201,
  );

  const applied = withAppliedChange
    ? await ok(
        await cmd(
          envelope("workspace.apply_changeset", {
            source: "API",
            message: "Add README",
            base_workspace_revision: 0,
            operations: [{ type: "create", path: "README.md", content: "# Alpha\n" }],
          }),
          agent.tokens.access_token,
        ),
      )
    : { response: { applied_revision: 0 } };
  return { roomId, owner, agent, applied, cmd };
}

describe("composeServer", () => {
  it("stops agent sandboxes on freeze and cleans up on participant removal and archive", async () => {
    const driver = new RecordingExecutionDriver();
    const { server } = await start({}, new RecordingPublisher(), { executionDriver: driver });
    const first = await walkthrough(server.app, false);
    const agentRows = await db.pool.query<{ id: string }>(
      "SELECT id FROM participants WHERE room_id = $1 AND kind = 'AGENT'",
      [first.roomId],
    );
    const agentId = agentRows.rows[0]!.id;
    const agentSandbox = await server.execution.ensure(first.roomId, agentId);

    await ok(await first.cmd(envelope("room.freeze"), first.owner.tokens.access_token));
    expect(await server.execution.get(first.roomId, agentId)).toMatchObject({
      id: agentSandbox.id,
      status: "HIBERNATED",
    });
    await ok(await first.cmd(envelope("room.resume"), first.owner.tokens.access_token));
    await ok(
      await first.cmd(
        envelope("participants.remove", { participant_id: agentId }),
        first.owner.tokens.access_token,
      ),
    );
    expect(await server.execution.get(first.roomId, agentId)).toMatchObject({
      id: agentSandbox.id,
      status: "DESTROYED",
    });

    const second = await walkthrough(server.app, false);
    const ownerRows = await db.pool.query<{ id: string }>(
      "SELECT id FROM participants WHERE room_id = $1 AND authority = 'OWNER'",
      [second.roomId],
    );
    const ownerSandbox = await server.execution.ensure(second.roomId, ownerRows.rows[0]!.id);
    await ok(await second.cmd(envelope("room.archive"), second.owner.tokens.access_token));
    expect(await server.execution.get(second.roomId, ownerRows.rows[0]!.id)).toMatchObject({
      id: ownerSandbox.id,
      status: "DESTROYED",
    });
    expect(driver.stopped).toHaveLength(1);
    expect(driver.destroyed).toHaveLength(2);
  });

  it("serves the skeleton flow end to end: login, create, session, invite, join, apply, read", async () => {
    const { server, publisher } = await start();
    const { roomId, owner, applied, cmd } = await walkthrough(server.app);

    expect(applied.response).toMatchObject({ status: "APPLIED", applied_revision: 1 });

    const read = await ok(
      await cmd(envelope("workspace.read", { path: "README.md" }), owner.tokens.access_token),
    );
    expect(read.response).toMatchObject({ content: "# Alpha\n" });

    const state = await ok(await cmd(envelope("room.get_state"), owner.tokens.access_token));
    expect(state.response.sections.room).toMatchObject({ id: roomId, status: "ACTIVE" });

    // Every committed command was published, in ledger order.
    const types = publisher.events.filter((e) => e.room_id === roomId).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["room.created", "participant.joined", "workspace.changeset.applied"]),
    );
    const seqs = publisher.events.filter((e) => e.room_id === roomId).map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("serves tasks, messages, room events and room lifecycle over HTTP", async () => {
    const { server } = await start();
    const { roomId, owner, agent, cmd } = await walkthrough(server.app);
    const ownerToken = owner.tokens.access_token as string;
    const agentToken = agent.tokens.access_token as string;

    const created = await ok(
      await cmd(
        envelope("tasks.create", { title: "Login form", requirements: ["Form submits"] }),
        ownerToken,
      ),
    );
    const task = created.response as { id: string; version: number };
    const claimed = await ok(
      await cmd(
        envelope("tasks.claim", { task_id: task.id, expected_version: task.version }),
        agentToken,
      ),
    );
    await ok(
      await cmd(
        envelope("tasks.start", { task_id: task.id, expected_version: claimed.response.version }),
        agentToken,
      ),
    );
    await ok(
      await cmd(
        envelope("messages.send", {
          body: "Starting on the login form",
          refs: [{ kind: "task", id: task.id }],
        }),
        agentToken,
      ),
    );

    const got = await ok(await cmd(envelope("tasks.get", { task_id: task.id }), ownerToken));
    expect(got.response).toMatchObject({ status: "IN_PROGRESS" });
    const messages = await ok(await cmd(envelope("messages.list"), ownerToken));
    expect(messages.response.messages).toMatchObject([{ body: "Starting on the login form" }]);

    const events = await server.app.inject({
      method: "GET",
      url: `/v1/rooms/${roomId}/events?types=task.*`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(events.statusCode, events.body).toBe(200);
    expect(events.json().events.map((e: RoomEvent) => e.type)).toEqual([
      "task.created",
      "task.claimed",
      "task.started",
    ]);

    // Room lifecycle: a frozen room refuses the agent's mutations until the owner resumes it.
    await ok(await cmd(envelope("room.freeze"), ownerToken));
    const refused = await cmd(envelope("messages.send", { body: "Still here?" }), agentToken);
    expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
    expect(refused.json().error.code).toBe("ROOM_PAUSED");
    await ok(await cmd(envelope("room.resume"), ownerToken));
    await ok(await cmd(envelope("messages.send", { body: "Back" }), agentToken));
  });

  it("blocks task approval until the configured health run covers the submission revision", async () => {
    const { server } = await start();
    const { roomId, owner, agent, applied, cmd } = await walkthrough(server.app, false);
    const ownerToken = owner.tokens.access_token as string;
    const agentToken = agent.tokens.access_token as string;
    await db.pool.query(
      "UPDATE rooms SET settings = jsonb_set(settings, '{health_command}', to_jsonb('pnpm test'::text)) WHERE id = $1",
      [roomId],
    );

    const created = await ok(
      await cmd(
        envelope("tasks.create", { title: "Review health gate", requirements: ["Build passes"] }),
        ownerToken,
      ),
    );
    const claimed = await ok(
      await cmd(
        envelope("tasks.claim", {
          task_id: created.response.id,
          expected_version: created.response.version,
        }),
        agentToken,
      ),
    );
    const started = await ok(
      await cmd(
        envelope("tasks.start", {
          task_id: created.response.id,
          expected_version: claimed.response.version,
        }),
        agentToken,
      ),
    );
    const submitted = await ok(
      await cmd(
        envelope("tasks.submit", {
          task_id: created.response.id,
          expected_version: started.response.version,
        }),
        agentToken,
      ),
    );

    const approval = () =>
      cmd(
        envelope("tasks.review", {
          task_id: created.response.id,
          expected_version: submitted.response.version,
          verdict: "approve",
        }),
        ownerToken,
      );
    const blocked = await approval();
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.details).toMatchObject({
      reason: "health_gate_pending",
      required_revision: 0,
      latest_run: null,
    });

    const { rows: workspaces } = await db.pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE room_id = $1",
      [roomId],
    );
    await db.pool.query(
      `INSERT INTO health_runs (id, workspace_id, room_id, revision, status, duration_ms, log)
       VALUES ($1, $2, $3, $4, 'GREEN', 10, 'private health output')`,
      [newId("health"), workspaces[0]!.id, roomId, applied.response.applied_revision],
    );
    const approved = await ok(await approval());
    expect(approved.response).toMatchObject({ status: "DONE" });
  });

  it("serves the inbox over HTTP: an empty list, and NOT_FOUND for an id that isn't theirs", async () => {
    const { server } = await start();
    const { owner, agent, cmd } = await walkthrough(server.app);
    const listed = await ok(await cmd(envelope("inbox.list"), owner.tokens.access_token));
    expect(listed.response).toEqual({ items: [], has_more: false });
    const res = await cmd(
      envelope("inbox.ack", { ids: ["inbox_not_mine"] }),
      agent.tokens.access_token,
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("streams a room's events over WebSocket after hello and subscribe", async () => {
    const { server } = await start();
    const { roomId, owner } = await walkthrough(server.app);
    const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
    const sock = new WebSocket(`${address.replace("http", "ws")}/v1/rooms/${roomId}/ws`);
    const frames: { type: string; event?: RoomEvent }[] = [];
    sock.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
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
        token: owner.tokens.access_token,
      }),
    );
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(done(), JSON.stringify(frames).slice(0, 500)).toBe(true);
    };
    await until(() => frames.some((f) => f.type === "hello_ok"));
    sock.send(JSON.stringify({ type: "subscribe", after: 0 }));
    await until(() =>
      frames.some((f) => f.type === "event" && f.event?.type === "workspace.changeset.applied"),
    );
    const seqs = frames.filter((f) => f.type === "event").map((f) => f.event!.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    sock.close();
  });

  it("registers the task lifecycle and heartbeat, and its sweeper returns a lapsed claim to OPEN", async () => {
    const { server } = await start({}, new RecordingPublisher(), { leaseSweepIntervalMs: 50 });
    const { roomId, owner, agent, cmd } = await walkthrough(server.app);
    const created = await ok(
      await cmd(
        envelope("tasks.create", { title: "Work", requirements: ["done"] }),
        owner.tokens.access_token,
      ),
    );
    const claimed = await ok(
      await cmd(
        envelope("tasks.claim", {
          task_id: created.response.id,
          expected_version: created.response.version,
        }),
        agent.tokens.access_token,
      ),
    );
    const beat = await ok(
      await cmd(
        envelope("tasks.heartbeat", { task_id: created.response.id }),
        agent.tokens.access_token,
      ),
    );
    expect(beat.response.lease_expires_at).toEqual(expect.any(String));

    await db.pool.query(
      "UPDATE tasks SET lease_expires_at = now() - interval '1 minute' WHERE id = $1",
      [created.response.id],
    );
    let status = claimed.response.status as string;
    for (let i = 0; i < 100 && status !== "OPEN"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const got = await ok(
        await cmd(
          envelope("tasks.get", { task_id: created.response.id }),
          owner.tokens.access_token,
        ),
      );
      status = got.response.task?.status ?? got.response.status;
    }
    expect(status).toBe("OPEN");
    void roomId;
  });

  it("serves decisions over HTTP: propose, then a position, which a second one replaces", async () => {
    const { server } = await start();
    const { owner, agent, cmd } = await walkthrough(server.app);
    const proposed = await ok(
      await cmd(
        envelope("decisions.propose", {
          title: "Pick a database",
          options: [{ summary: "PostgreSQL" }, { summary: "SQLite" }],
        }),
        owner.tokens.access_token,
      ),
    );
    expect(proposed.response).toMatchObject({ status: "PROPOSED", version: 1 });
    const position = (option: string) =>
      cmd(
        envelope("decisions.add_position", {
          decision_id: proposed.response.id,
          option_id: option,
          argument: "because",
        }),
        agent.tokens.access_token,
      );
    expect((await ok(await position("opt_1"))).response).toMatchObject({ replaced: false });
    expect((await ok(await position("opt_2"))).response).toMatchObject({ replaced: true });
    const bad = await position("opt_9");
    expect(bad.statusCode).toBe(400);
  });

  it("serves MCP at /mcp with the task tools, authenticated by the room token", async () => {
    const { server } = await start();
    const { agent } = await walkthrough(server.app);
    const rpc = (token: string | undefined, body: unknown) =>
      server.app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        payload: JSON.stringify(body),
      });
    expect((await rpc(undefined, { jsonrpc: "2.0", id: 1, method: "tools/list" })).statusCode).toBe(
      401,
    );
    const res = await rpc(agent.tokens.access_token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("tasks_create");
    expect(res.body).toContain("tasks_heartbeat");
  });

  it("serves room.digest over HTTP: counts per type since a sequence, identical on repeat", async () => {
    const { server } = await start();
    const { owner, cmd } = await walkthrough(server.app);
    const ask = async (params: Record<string, unknown>) =>
      (await ok(await cmd(envelope("room.digest", params), owner.tokens.access_token))).response;
    const all = await ask({});
    expect(all.counts).toMatchObject({
      "room.created": 1,
      "participant.joined": 2, // the owner and the agent
      "workspace.changeset.applied": 1,
    });
    expect(await ask({})).toEqual(all);
    expect(await ask({ since: all.up_to })).toMatchObject({ event_count: 0, up_to: all.up_to });
  });

  it("serves decide, withdraw, get and list over HTTP: the lead decides, a developer can't", async () => {
    const { server } = await start();
    const { owner, agent, cmd } = await walkthrough(server.app);
    const propose = async (token: string) =>
      (
        await ok(
          await cmd(
            envelope("decisions.propose", {
              title: "Pick a database",
              options: [{ summary: "PostgreSQL" }, { summary: "SQLite" }],
            }),
            token,
          ),
        )
      ).response;
    const first = await propose(agent.tokens.access_token);
    const decide = (token: string, d: { id: string; version: number }) =>
      cmd(
        envelope("decisions.decide", {
          decision_id: d.id,
          expected_version: d.version,
          outcome_option_id: "opt_1",
          rationale: "We run it already",
        }),
        token,
      );
    // The agent is a developer: it can propose but not decide.
    expect((await decide(agent.tokens.access_token, first)).statusCode).toBe(403);

    const withdrawn = await ok(
      await cmd(
        envelope("decisions.withdraw", { decision_id: first.id, expected_version: 1 }),
        agent.tokens.access_token,
      ),
    );
    expect(withdrawn.response.status).toBe("WITHDRAWN");

    const second = await propose(agent.tokens.access_token);
    const got = await ok(
      await cmd(envelope("decisions.get", { decision_id: second.id }), owner.tokens.access_token),
    );
    expect(got.response).toMatchObject({ id: second.id, status: "PROPOSED" });
    const listed = await ok(
      await cmd(envelope("decisions.list", { status: ["PROPOSED"] }), owner.tokens.access_token),
    );
    expect(listed.response.decisions.map((d: { id: string }) => d.id)).toEqual([second.id]);
  });

  it("serves memory.put over HTTP with compare-and-set", async () => {
    const { server } = await start();
    const { owner, agent, cmd } = await walkthrough(server.app);
    const put = (token: string, params: Record<string, unknown>) =>
      cmd(envelope("memory.put", { key: "architecture/database", ...params }), token);
    const created = await ok(
      await put(owner.tokens.access_token, { value: "PostgreSQL", expected_revision: 0 }),
    );
    expect(created.response).toMatchObject({ revision: 1, value: "PostgreSQL" });
    const stale = await put(agent.tokens.access_token, { value: "SQLite", expected_revision: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details.current).toMatchObject({ revision: 1 });
    const updated = await ok(
      await put(agent.tokens.access_token, { value: "Postgres 16", expected_revision: 1 }),
    );
    expect(updated.response).toMatchObject({ revision: 2 });
  });

  it("serves memory get, list, history and delete over HTTP", async () => {
    const { server } = await start();
    const { owner, agent, cmd } = await walkthrough(server.app);
    const call = async (token: string, method: string, params: Record<string, unknown>) =>
      cmd(envelope(method, params), token);
    await ok(
      await call(agent.tokens.access_token, "memory.put", {
        key: "architecture/database",
        value: "PostgreSQL",
        expected_revision: 0,
      }),
    );
    const got = await ok(
      await call(owner.tokens.access_token, "memory.get", { key: "architecture/database" }),
    );
    expect(got.response).toMatchObject({ value: "PostgreSQL", revision: 1 });
    const listed = await ok(
      await call(owner.tokens.access_token, "memory.list", { prefix: "architecture/" }),
    );
    expect(listed.response.entries.map((e: { key: string }) => e.key)).toEqual([
      "architecture/database",
    ]);
    await ok(
      await call(agent.tokens.access_token, "memory.delete", {
        key: "architecture/database",
        expected_revision: 1,
      }),
    );
    expect(
      (await call(owner.tokens.access_token, "memory.get", { key: "architecture/database" }))
        .statusCode,
    ).toBe(404);
    const history = await ok(
      await call(owner.tokens.access_token, "memory.history", { key: "architecture/database" }),
    );
    expect(history.response.revisions.map((r: { deleted: boolean }) => r.deleted)).toEqual([
      false,
      true,
    ]);
  });

  it("serves decisions.veto over HTTP: the owner may, a developer may not", async () => {
    const { server } = await start();
    const { owner, agent, cmd } = await walkthrough(server.app);
    const proposed = (
      await ok(
        await cmd(
          envelope("decisions.propose", {
            title: "Pick a database",
            options: [{ summary: "PostgreSQL" }, { summary: "SQLite" }],
          }),
          agent.tokens.access_token,
        ),
      )
    ).response;
    // Decided by the lead in a real room; here, put it in the state a decision would be in.
    await db.pool.query(
      `UPDATE decisions SET status = 'ACCEPTED', outcome_option_id = 'opt_1', rationale = 'r',
              decided_by = proposed_by, decided_at = now(), version = 2 WHERE id = $1`,
      [proposed.id],
    );
    const veto = (token: string) =>
      cmd(
        envelope("decisions.veto", {
          decision_id: proposed.id,
          expected_version: 2,
          rationale: "Too risky",
        }),
        token,
      );
    expect((await veto(agent.tokens.access_token)).statusCode).toBe(403);
    const vetoed = await ok(await veto(owner.tokens.access_token));
    expect(vetoed.response).toMatchObject({ status: "VETOED", version: 3 });
  });

  it("serves participants.update_manifest over HTTP: self only, and the owner is told", async () => {
    const { server } = await start();
    const { owner, agent, roomId, cmd } = await walkthrough(server.app);
    const me = (
      await db.pool.query(
        "SELECT id, agent_manifest FROM participants WHERE room_id = $1 AND kind = 'AGENT'",
        [roomId],
      )
    ).rows[0];
    const { self_declared: _platform, ...declared } = me.agent_manifest; // the platform adds it at join
    void _platform;
    const next = { ...declared, model: "a-newer-model" };
    const updated = await ok(
      await cmd(
        envelope("participants.update_manifest", { manifest: next }),
        agent.tokens.access_token,
      ),
    );
    expect(updated.response).toMatchObject({
      changed: true,
      changes: { model: { before: "test-model", after: "a-newer-model" } },
    });
    const forbidden = await cmd(
      envelope("participants.update_manifest", { participant_id: me.id, manifest: next }),
      owner.tokens.access_token,
    );
    expect(forbidden.statusCode).toBe(403);
    const inbox = await ok(await cmd(envelope("inbox.list"), owner.tokens.access_token));
    expect(inbox.response.items.map((i: { kind: string }) => i.kind)).toContain("MANIFEST_CHANGED");
  });

  it("enforces the real policy: an observer can't apply a ChangeSet", async () => {
    const { server } = await start();
    const { owner, cmd, roomId } = await walkthrough(server.app);
    const invite = await ok(
      await cmd(envelope("room.invite", { role: "OBSERVER" }), owner.tokens.access_token),
    );
    const observer = await ok(
      await post(server.app, `/v1/rooms/${roomId}/join`, {
        token: invite.one_time.token,
        manifest: {
          name: "Watcher",
          operator: { name: "Peter", contact: "peter@example.com" },
          vendor: "Anthropic",
          model: "test-model",
          client: "mcp",
          client_version: "1.0.0",
          description: "Watches",
        },
      }),
      201,
    );
    const res = await cmd(
      envelope("workspace.apply_changeset", {
        source: "API",
        message: "Sneaky",
        base_workspace_revision: 1,
        operations: [{ type: "create", path: "x.md", content: "x\n" }],
      }),
      observer.tokens.access_token,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("on taking over a room, repairs a drifted Git ref from PostgreSQL before the first command", async () => {
    const first = await start();
    const { roomId, owner } = await walkthrough(first.server.app);
    const { rows } = await db.pool.query<{ repo_path: string; commit_sha: string }>(
      `SELECT w.repo_path, r.commit_sha FROM workspaces w
       JOIN workspace_revisions r ON r.workspace_id = w.id AND r.room_id = w.room_id
       WHERE w.room_id = $1 ORDER BY r.revision`,
      [roomId],
    );
    const [rev0, rev1] = rows;
    expect(rev1).toBeDefined();

    // Shutdown releases the lease, so a second node can take the room over at once.
    await first.server.close();

    // Simulate a crash between the commit and the ref update: Git lags the database.
    await git(["update-ref", "refs/room/canonical", rev0!.commit_sha], {
      gitDir: rev0!.repo_path,
      timeoutMs: 10_000,
    });

    // Reads don't take the lease; the first mutation does, and reconciles before it runs.
    const second = await start();
    const res = await post(
      second.server.app,
      `/v1/rooms/${roomId}/commands`,
      envelope("workspace.apply_changeset", {
        source: "API",
        message: "Second edit",
        base_workspace_revision: 1,
        operations: [{ type: "modify", path: "README.md", content: "# Alpha 2\n" }],
      }),
      owner.tokens.access_token,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().response).toMatchObject({ status: "APPLIED", applied_revision: 2 });
    const head = await db.pool.query<{ commit_sha: string }>(
      `SELECT r.commit_sha FROM workspace_revisions r
       WHERE r.room_id = $1 ORDER BY r.revision DESC LIMIT 1`,
      [roomId],
    );
    const ref = await git(["rev-parse", "refs/room/canonical", "refs/room/canonical~1"], {
      gitDir: rev0!.repo_path,
      timeoutMs: 10_000,
    });
    // The ref was repaired to revision 1 first, so revision 2 builds on it and the ref follows.
    expect(ref.stdout.trim().split("\n")).toEqual([head.rows[0]!.commit_sha, rev1!.commit_sha]);
  });

  it("composes against the real Redis publisher and shuts down cleanly, twice", async () => {
    const server = await composeServer(config(), { pool: db.pool });
    await walkthrough(server.app);
    await server.close();
    await server.close();
  });
});

describe("loadConfig", () => {
  const env = {
    DATABASE_URL: "postgres://x",
    REDIS_URL: "redis://x",
    WORKSPACE_ROOT: "./data",
  };

  it("applies defaults: loopback, port 8080, dev login off, a node id", () => {
    const c = loadConfig(env);
    expect(c).toMatchObject({ host: "127.0.0.1", port: 8080, devLogin: false });
    expect(c.healthImages).toEqual(["node:22-bookworm-slim"]);
    expect(c.nodeId).toMatch(/-\d+$/);
    expect(c.workspaceRoot.startsWith("/")).toBe(true);
  });

  it("turns dev login on only for an explicit true", () => {
    expect(loadConfig({ ...env, DEV_LOGIN: "true" }).devLogin).toBe(true);
    expect(loadConfig({ ...env, DEV_LOGIN: "0" }).devLogin).toBe(false);
    expect(() => loadConfig({ ...env, DEV_LOGIN: "yes" })).toThrow(/DEV_LOGIN/);
  });

  it("parses the operator health image allowlist", () => {
    expect(loadConfig({ ...env, HEALTH_IMAGES: "node:22, python:3.13 " }).healthImages).toEqual([
      "node:22",
      "python:3.13",
    ]);
    expect(() => loadConfig({ ...env, HEALTH_IMAGES: " , " })).toThrow(/HEALTH_IMAGES/);
  });

  it("names every missing or malformed variable at once", () => {
    expect(() => loadConfig({ PORT: "99999" })).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL[\s\S]*WORKSPACE_ROOT[\s\S]*PORT/,
    );
  });
});
