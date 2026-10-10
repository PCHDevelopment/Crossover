import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import type { Authorizer, EventPublisher } from "@crossover/kernel";
import { CrossoverError, newId, type RoomEvent } from "@crossover/protocol";
import {
  git,
  type ExecutionDriver,
  type SandboxExecOutcome,
  type SandboxExecProcess,
  type SandboxLimits,
} from "@crossover/workspace";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  readonly working = new Map<string, Map<string, { mode: string; content: Buffer }>>();
  readonly snapshotRules = new Map<string, { path: string; patterns: string[] }[]>();
  failSnapshotUpdate = false;
  finishExec: ((outcome: SandboxExecOutcome) => void) | undefined;
  snapshotInventoryPause: { started: () => void; wait: Promise<void> } | undefined;

  async create({ sandbox_id }: { sandbox_id: string; limits: SandboxLimits }) {
    this.working.set(sandbox_id, this.working.get(sandbox_id) ?? new Map());
    return { volume_ref: `volume:${sandbox_id}`, container_ref: `container:${sandbox_id}` };
  }
  async status(_input: Parameters<ExecutionDriver["status"]>[0]) {
    return { modified: [], added: [], deleted: [], truncated: false };
  }
  async materialize(
    _input: Parameters<NonNullable<ExecutionDriver["materialize"]>>[0],
  ): Promise<void> {}
  async snapshotInventory(input: Parameters<NonNullable<ExecutionDriver["snapshotInventory"]>>[0]) {
    const pause = this.snapshotInventoryPause;
    if (pause) {
      this.snapshotInventoryPause = undefined;
      pause.started();
      await pause.wait;
    }
    this.snapshotRules.set(input.sandbox_id, input.ignore_rules ?? []);
    const files = this.working.get(input.sandbox_id) ?? new Map();
    const tracked = new Set(input.tracked_paths);
    return [...files].map(([path, file]) => ({
      path,
      mode: file.mode,
      sha: tracked.has(path) ? gitBlobHash(file.content, input.object_format) : null,
      size: file.content.length,
    }));
  }
  async readSnapshotFiles(input: Parameters<NonNullable<ExecutionDriver["readSnapshotFiles"]>>[0]) {
    const files = this.working.get(input.sandbox_id) ?? new Map();
    return input.files.map((expected) => {
      const file = files.get(expected.path);
      if (!file) throw new Error("test sandbox path disappeared");
      const sha = gitBlobHash(file.content, input.object_format);
      if (
        file.mode !== expected.mode ||
        file.content.length !== expected.size ||
        (expected.sha !== null && expected.sha !== sha)
      ) {
        throw new CrossoverError("CONFLICT_VERSION", "test sandbox changed during snapshot");
      }
      return {
        path: expected.path,
        mode: file.mode,
        sha,
        size: file.content.length,
        content: file.content,
      };
    });
  }
  async updateSnapshot(
    input: Parameters<NonNullable<ExecutionDriver["updateSnapshot"]>>[0],
  ): Promise<void> {
    if (this.failSnapshotUpdate) {
      this.failSnapshotUpdate = false;
      throw new Error("injected snapshot update failure");
    }
    const files = this.working.get(input.sandbox_id) ?? new Map();
    for (const path of input.delete_paths) files.delete(path);
    for (const file of input.files)
      files.set(file.path, { mode: file.mode, content: Buffer.from(file.content) });
    this.working.set(input.sandbox_id, files);
  }
  async exec(): Promise<SandboxExecProcess> {
    let finish!: (outcome: SandboxExecOutcome) => void;
    const finished = new Promise<SandboxExecOutcome>((resolve) => (finish = resolve));
    this.finishExec = finish;
    return {
      finished,
      cancel: async (reason) => finish({ exit_code: null, duration_ms: 1, reason }),
    };
  }
  async start(_input: { sandbox_id: string }): Promise<void> {}
  async stop(input: { sandbox_id: string }): Promise<void> {
    this.stopped.push(input.sandbox_id);
  }
  async destroy(input: { sandbox_id: string }): Promise<void> {
    this.destroyed.push(input.sandbox_id);
  }
}

function gitBlobHash(content: Buffer, format: "sha1" | "sha256"): string {
  return createHash(format).update(`blob ${content.length}\0`).update(content).digest("hex");
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

async function ownerParticipantId(roomId: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    "SELECT id FROM participants WHERE room_id = $1 AND authority = 'OWNER'",
    [roomId],
  );
  return rows[0]!.id;
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

  it("serves sandbox.status for the caller's own materialized working copy", async () => {
    const driver = new RecordingExecutionDriver();
    const { server } = await start({}, new RecordingPublisher(), { executionDriver: driver });
    const { owner, cmd } = await walkthrough(server.app, false);

    const status = await ok(await cmd(envelope("sandbox.status"), owner.tokens.access_token));
    expect(status.response).toEqual({
      base_revision: 0,
      head_revision: 0,
      behind_by: 0,
      modified: [],
      added: [],
      deleted: [],
      truncated: false,
    });
  });

  it("submits a raw sandbox diff, advances the base only after apply, and refuses a no-op", async () => {
    const driver = new RecordingExecutionDriver();
    const { server, publisher } = await start({}, new RecordingPublisher(), {
      executionDriver: driver,
    });
    const { roomId, owner, cmd } = await walkthrough(server.app, false);
    const participantId = await ownerParticipantId(roomId);
    const sandbox = await server.execution.ensure(roomId, participantId);
    driver.working.get(sandbox.id)!.set("submitted.bin", {
      mode: "100644",
      content: Buffer.from([0, 1, 0xff, 10]),
    });

    const request = envelope("changes.submit", { message: "Submit binary output" });
    const first = await ok(await cmd(request, owner.tokens.access_token));
    expect(first.response).toMatchObject({
      status: "APPLIED",
      applied_revision: 1,
      base_revision: 0,
      sandbox_advance: "scheduled",
    });
    await server.dispatcher.actors.get(roomId).idle();
    expect(publisher.events.filter((event) => event.type === "sandbox.synced")).toMatchObject([
      {
        actor_id: "system",
        payload: { participant_id: participantId, base_revision: 1 },
      },
    ]);
    expect(driver.working.get(sandbox.id)!.get("submitted.bin")?.content).toEqual(
      Buffer.from([0, 1, 0xff, 10]),
    );
    expect(await server.execution.get(roomId, participantId)).toMatchObject({
      base_revision: 1,
    });

    const replay = await ok(await cmd(request, owner.tokens.access_token));
    expect(replay.response).toMatchObject({
      status: "APPLIED",
      applied_revision: 1,
      base_revision: 0,
      sandbox_advance: "scheduled",
    });
    expect(publisher.events.filter((event) => event.type === "sandbox.synced")).toHaveLength(1);
    const priorEventCount = publisher.events.filter((event) => event.room_id === roomId).length;
    const noChanges = await cmd(
      envelope("changes.submit", { message: "Nothing to submit" }),
      owner.tokens.access_token,
    );
    expect(noChanges.statusCode).toBe(400);
    expect(noChanges.json().error).toMatchObject({
      code: "VALIDATION",
      retryable: false,
      details: { reason: "no_changes" },
    });
    expect(publisher.events.filter((event) => event.room_id === roomId)).toHaveLength(
      priorEventCount,
    );
    const count = await db.pool.query<{ count: string }>(
      "SELECT count(*) FROM changesets WHERE room_id = $1",
      [roomId],
    );
    expect(Number(count.rows[0]!.count)).toBe(1);
  });

  it("reports a failed queued advance while submit still moves its own base", async () => {
    const driver = new RecordingExecutionDriver();
    const { server, publisher } = await start({}, new RecordingPublisher(), {
      executionDriver: driver,
    });
    const { roomId, owner, cmd } = await walkthrough(server.app, false);
    const participantId = await ownerParticipantId(roomId);
    const sandbox = await server.execution.ensure(roomId, participantId);
    driver.working.get(sandbox.id)!.set("submitted.txt", {
      mode: "100644",
      content: Buffer.from("submitted"),
    });
    driver.failSnapshotUpdate = true;

    const applied = await ok(
      await cmd(
        envelope("changes.submit", { message: "Submit before failed advance" }),
        owner.tokens.access_token,
      ),
    );
    expect(applied.response).toMatchObject({
      status: "APPLIED",
      applied_revision: 1,
      base_revision: 0,
      sandbox_advance: "scheduled",
    });
    await vi.waitFor(() => {
      expect(
        publisher.events.some(
          (event) =>
            event.room_id === roomId &&
            event.type === "sandbox.behind" &&
            event.payload.reason === "advance_failed",
        ),
      ).toBe(true);
    });
    expect(publisher.events.find((event) => event.type === "sandbox.behind")).toMatchObject({
      actor_id: "system",
      payload: { participant_id: participantId, behind_by: 1, reason: "advance_failed" },
    });
    const status = await ok(await cmd(envelope("sandbox.status"), owner.tokens.access_token));
    expect(status.response).toMatchObject({ base_revision: 1, head_revision: 1, behind_by: 0 });
  });

  it("reports process_running instead of claiming a blocked submit advance synced", async () => {
    const driver = new RecordingExecutionDriver();
    const { server, publisher } = await start({}, new RecordingPublisher(), {
      executionDriver: driver,
    });
    const { roomId, owner, cmd } = await walkthrough(server.app, false);
    const participantId = await ownerParticipantId(roomId);
    const sandbox = await server.execution.ensure(roomId, participantId);
    await ok(
      await cmd(
        envelope("sandbox.exec", { command: "long running command" }),
        owner.tokens.access_token,
      ),
    );
    await server.dispatcher.actors.get(roomId).idle();
    expect(driver.finishExec).toBeDefined();

    driver.working.get(sandbox.id)!.set("submitted.txt", {
      mode: "100644",
      content: Buffer.from("submit while running"),
    });
    await ok(
      await cmd(
        envelope("changes.submit", { message: "Submit during a process" }),
        owner.tokens.access_token,
      ),
    );
    await server.dispatcher.actors.get(roomId).idle();
    expect(publisher.events.filter((event) => event.type === "sandbox.synced")).toHaveLength(0);
    expect(publisher.events.find((event) => event.type === "sandbox.behind")).toMatchObject({
      actor_id: "system",
      payload: { participant_id: participantId, reason: "process_running" },
    });
    expect(await server.execution.get(roomId, participantId)).toMatchObject({ base_revision: 0 });

    driver.finishExec!({ exit_code: 0, duration_ms: 1, reason: "exit" });
    await server.dispatcher.actors.get(roomId).idle();
  });

  it("rejects unmatched filters and selects exact files or directory prefixes only", async () => {
    const driver = new RecordingExecutionDriver();
    const { server } = await start({}, new RecordingPublisher(), { executionDriver: driver });
    const { roomId, owner, cmd } = await walkthrough(server.app, false);
    const participantId = await ownerParticipantId(roomId);
    const sandbox = await server.execution.ensure(roomId, participantId);
    const working = driver.working.get(sandbox.id)!;
    working.set("app/[slug]/page.tsx", { mode: "100644", content: Buffer.from("export {};") });
    working.set("app/[slug]/page.tsx.map", { mode: "100644", content: Buffer.from("map") });
    working.set("root.txt", { mode: "100644", content: Buffer.from("local only") });

    const typo = await cmd(
      envelope("changes.submit", {
        paths: ["app/[slug]/mian.tsx"],
        message: "Catch a path filter typo",
      }),
      owner.tokens.access_token,
    );
    expect(typo.statusCode).toBe(400);
    expect(typo.json().error).toMatchObject({
      code: "VALIDATION",
      details: { reason: "path_not_changed", path: "app/[slug]/mian.tsx" },
    });

    const exact = await ok(
      await cmd(
        envelope("changes.submit", {
          paths: ["app/[slug]/page.tsx"],
          message: "Submit one exact path",
        }),
        owner.tokens.access_token,
      ),
    );
    expect(exact.response).toMatchObject({ status: "APPLIED", applied_revision: 1 });
    const workspace = await db.pool.query<{ repo_path: string; commit_sha: string }>(
      `SELECT w.repo_path, wr.commit_sha FROM workspaces w
       JOIN workspace_revisions wr ON wr.workspace_id = w.id AND wr.room_id = w.room_id
       WHERE w.room_id = $1 AND wr.revision = 1`,
      [roomId],
    );
    await expect(
      git(["cat-file", "-e", `${workspace.rows[0]!.commit_sha}:app/[slug]/page.tsx`], {
        gitDir: workspace.rows[0]!.repo_path,
        timeoutMs: 10_000,
      }),
    ).resolves.toBeDefined();
    await expect(
      git(["cat-file", "-e", `${workspace.rows[0]!.commit_sha}:root.txt`], {
        gitDir: workspace.rows[0]!.repo_path,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();
    await expect(
      git(["cat-file", "-e", `${workspace.rows[0]!.commit_sha}:app/[slug]/page.tsx.map`], {
        gitDir: workspace.rows[0]!.repo_path,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();

    const directory = await ok(
      await cmd(
        envelope("changes.submit", { paths: ["app/"], message: "Submit the remaining app file" }),
        owner.tokens.access_token,
      ),
    );
    expect(directory.response).toMatchObject({
      status: "APPLIED",
      applied_revision: 2,
      base_revision: 1,
      sandbox_advance: "scheduled",
    });
    const secondRevision = await db.pool.query<{ repo_path: string; commit_sha: string }>(
      `SELECT w.repo_path, wr.commit_sha FROM workspaces w
       JOIN workspace_revisions wr ON wr.workspace_id = w.id AND wr.room_id = w.room_id
       WHERE w.room_id = $1 AND wr.revision = 2`,
      [roomId],
    );
    await expect(
      git(["cat-file", "-e", `${secondRevision.rows[0]!.commit_sha}:app/[slug]/page.tsx.map`], {
        gitDir: secondRevision.rows[0]!.repo_path,
        timeoutMs: 10_000,
      }),
    ).resolves.toBeDefined();
  });

  it("includes sandbox owner identity and redacts changed paths from a scoped reader", async () => {
    const driver = new RecordingExecutionDriver();
    const { server } = await start({}, new RecordingPublisher(), { executionDriver: driver });
    const { roomId, owner, agent, cmd } = await walkthrough(server.app, false);
    const ownerId = await ownerParticipantId(roomId);
    const invite = await ok(
      await cmd(envelope("room.invite", { role: "DEVELOPER" }), owner.tokens.access_token),
    );
    const scoped = await ok(
      await post(server.app, `/v1/rooms/${roomId}/join`, {
        token: invite.one_time.token,
        manifest: {
          name: "Agent-B",
          operator: { name: "Peter", contact: "peter@example.com" },
          vendor: "Anthropic",
          model: "test-model",
          client: "mcp",
          client_version: "1.0.0",
          description: "Reads public files",
        },
      }),
      201,
    );
    const scopedId = scoped.participant_id as string;
    const scopedToken = scoped.tokens.access_token as string;
    await ok(
      await cmd(
        envelope("capabilities.revoke", {
          participant_id: scopedId,
          capability: "workspace.read:private/**",
        }),
        owner.tokens.access_token,
      ),
    );

    const sandbox = await server.execution.ensure(roomId, ownerId);
    const working = driver.working.get(sandbox.id)!;
    working.set("private/owner-only.txt", {
      mode: "100644",
      content: Buffer.from("sandbox version"),
    });
    working.set("submitted.txt", { mode: "100644", content: Buffer.from("submitted") });
    await ok(
      await cmd(
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Create a canonical version of the private path",
          base_workspace_revision: 0,
          operations: [
            { type: "create", path: "private/owner-only.txt", content: "canonical version" },
          ],
        }),
        agent.tokens.access_token,
      ),
    );
    await ok(
      await cmd(
        envelope("changes.submit", {
          paths: ["submitted.txt"],
          message: "Submit the disjoint sandbox file",
        }),
        owner.tokens.access_token,
      ),
    );

    const ownerEvents = await ok(
      await cmd(
        envelope("room.events.list", { types: ["sandbox.behind"] }),
        owner.tokens.access_token,
      ),
    );
    const scopedEvents = await ok(
      await cmd(envelope("room.events.list", { types: ["sandbox.behind"] }), scopedToken),
    );
    const ownerEvent = (ownerEvents.response.events as RoomEvent[])[0]!;
    const scopedEvent = (scopedEvents.response.events as RoomEvent[])[0]!;
    expect(ownerEvent.payload).toMatchObject({
      participant_id: ownerId,
      changed_paths: expect.arrayContaining(["private/owner-only.txt"]),
    });
    expect(scopedEvent.payload).toMatchObject({
      participant_id: ownerId,
      paths_redacted: true,
    });
    expect(scopedEvent.payload).not.toHaveProperty("changed_paths");
    expect(JSON.stringify(scopedEvent)).not.toContain("private/owner-only.txt");
  });

  it("revalidates every submitted path in the apply transaction", async () => {
    const driver = new RecordingExecutionDriver();
    const denyBlockedPath: Authorizer = async (_principal, action, resource) => {
      if (action === "workspace.write" && resource.path === "blocked.txt")
        throw new CrossoverError("FORBIDDEN", "The path is outside the write grant");
    };
    const { server } = await start({}, new RecordingPublisher(), {
      executionDriver: driver,
      authorize: denyBlockedPath,
    });
    const { roomId, owner, cmd } = await walkthrough(server.app, false);
    const participantId = await ownerParticipantId(roomId);
    const sandbox = await server.execution.ensure(roomId, participantId);
    driver.working.get(sandbox.id)!.set("blocked.txt", {
      mode: "100644",
      content: Buffer.from("do not apply"),
    });

    const denied = await cmd(
      envelope("changes.submit", { message: "Submit blocked path" }),
      owner.tokens.access_token,
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("FORBIDDEN");
    expect(await server.execution.get(roomId, participantId)).toMatchObject({
      base_revision: 0,
    });
    const count = await db.pool.query<{ count: string }>(
      "SELECT count(*) FROM changesets WHERE room_id = $1",
      [roomId],
    );
    expect(Number(count.rows[0]!.count)).toBe(0);
  });

  it("passes canonical ignore rules to snapshot inventory despite sandbox overrides", async () => {
    const driver = new RecordingExecutionDriver();
    const { server } = await start({}, new RecordingPublisher(), { executionDriver: driver });
    const { roomId, owner, cmd } = await walkthrough(server.app, false);
    await ok(
      await cmd(
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Add canonical ignore rule",
          base_workspace_revision: 0,
          operations: [{ type: "create", path: ".gitignore", content: "node_modules/\n" }],
        }),
        owner.tokens.access_token,
      ),
    );
    const ownerId = await db.pool.query<{ id: string }>(
      "SELECT id FROM participants WHERE room_id = $1 AND authority = 'OWNER'",
      [roomId],
    );
    const sandbox = await server.execution.ensure(roomId, ownerId.rows[0]!.id);
    const working = driver.working.get(sandbox.id)!;
    working.set(".gitignore", { mode: "100644", content: Buffer.from("!node_modules/\n") });
    working.set("src/app.ts", { mode: "100644", content: Buffer.from("export {};\n") });
    working.set("node_modules/pkg/index.js", {
      mode: "100644",
      content: Buffer.from("ignored dependency"),
    });

    const submitted = await ok(
      await cmd(
        envelope("changes.submit", { message: "Submit with canonical ignores" }),
        owner.tokens.access_token,
      ),
    );
    expect(submitted.response.status).toBe("APPLIED");
    expect(driver.snapshotRules.get(sandbox.id)).toEqual([
      { path: ".gitignore", patterns: ["node_modules/", ""] },
    ]);
    const workspace = await db.pool.query<{ repo_path: string; commit_sha: string }>(
      `SELECT w.repo_path, wr.commit_sha FROM workspaces w
       JOIN workspace_revisions wr ON wr.workspace_id = w.id AND wr.room_id = w.room_id
       WHERE w.room_id = $1 AND wr.revision = 2`,
      [roomId],
    );
    await expect(
      git(["cat-file", "-e", `${workspace.rows[0]!.commit_sha}:node_modules/pkg/index.js`], {
        gitDir: workspace.rows[0]!.repo_path,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();
  });

  it("refuses selected symlinks and leaves unrelated links untouched by filtered submits", async () => {
    const driver = new RecordingExecutionDriver();
    const { server } = await start({}, new RecordingPublisher(), { executionDriver: driver });
    const { roomId, owner, cmd } = await walkthrough(server.app, false);
    const participantId = await ownerParticipantId(roomId);
    const sandbox = await server.execution.ensure(roomId, participantId);
    const working = driver.working.get(sandbox.id)!;

    working.set("etc-passwd-link", { mode: "120000", content: Buffer.from("/etc/passwd") });
    const passwdLink = await cmd(
      envelope("changes.submit", { message: "Submit a link" }),
      owner.tokens.access_token,
    );
    expect(passwdLink.statusCode).toBe(400);
    expect(passwdLink.json().error).toMatchObject({
      code: "VALIDATION",
      details: { reason: "symlink_not_supported", path: "etc-passwd-link" },
    });

    working.delete("etc-passwd-link");
    working.set("src/a.ts", { mode: "100644", content: Buffer.from("export {};\n") });
    working.set("outside/symlink", {
      mode: "120000",
      content: Buffer.from("../../outside-scope.txt"),
    });
    const filtered = await ok(
      await cmd(
        envelope("changes.submit", {
          paths: ["src/"],
          message: "Submit src while leaving an unrelated link alone",
        }),
        owner.tokens.access_token,
      ),
    );
    expect(filtered.response).toMatchObject({ status: "APPLIED", applied_revision: 1 });
    expect(working.get("outside/symlink")).toMatchObject({
      mode: "120000",
      content: Buffer.from("../../outside-scope.txt"),
    });

    const workspace = await db.pool.query<{ repo_path: string; commit_sha: string }>(
      `SELECT w.repo_path, wr.commit_sha FROM workspaces w
       JOIN workspace_revisions wr ON wr.workspace_id = w.id AND wr.room_id = w.room_id
       WHERE w.room_id = $1 AND wr.revision = 1`,
      [roomId],
    );
    await expect(
      git(["cat-file", "-e", `${workspace.rows[0]!.commit_sha}:outside/symlink`], {
        gitDir: workspace.rows[0]!.repo_path,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();

    const selectedLink = await cmd(
      envelope("changes.submit", {
        paths: ["outside/symlink"],
        message: "Submit the link itself",
      }),
      owner.tokens.access_token,
    );
    expect(selectedLink.statusCode).toBe(400);
    expect(selectedLink.json().error).toMatchObject({
      code: "VALIDATION",
      details: { reason: "symlink_not_supported", path: "outside/symlink" },
    });

    const count = await db.pool.query<{ count: string }>(
      "SELECT count(*) FROM changesets WHERE room_id = $1",
      [roomId],
    );
    expect(Number(count.rows[0]!.count)).toBe(1);
    expect(await server.execution.get(roomId, participantId)).toMatchObject({
      base_revision: 1,
    });
  });

  it("ignores sandbox chmod-only changes and preserves the base mode on content edits", async () => {
    const driver = new RecordingExecutionDriver();
    const { server } = await start({}, new RecordingPublisher(), { executionDriver: driver });
    const { roomId, owner, cmd } = await walkthrough(server.app);
    const participantId = await ownerParticipantId(roomId);
    const sandbox = await server.execution.ensure(roomId, participantId);
    const working = driver.working.get(sandbox.id)!;
    working.set("README.md", { mode: "100755", content: Buffer.from("# Alpha\n") });

    const chmodOnly = await cmd(
      envelope("changes.submit", { message: "Submit chmod only" }),
      owner.tokens.access_token,
    );
    expect(chmodOnly.statusCode).toBe(400);
    expect(chmodOnly.json().error.details).toMatchObject({ reason: "no_changes" });

    working.set("README.md", { mode: "100755", content: Buffer.from("updated\n") });
    const edited = await ok(
      await cmd(
        envelope("changes.submit", { message: "Submit content edit" }),
        owner.tokens.access_token,
      ),
    );
    expect(edited.response).toMatchObject({
      status: "APPLIED",
      applied_revision: 2,
      base_revision: 1,
      sandbox_advance: "scheduled",
    });

    const workspace = await db.pool.query<{ repo_path: string; commit_sha: string }>(
      `SELECT w.repo_path, wr.commit_sha FROM workspaces w
       JOIN workspace_revisions wr ON wr.workspace_id = w.id AND wr.room_id = w.room_id
       WHERE w.room_id = $1 AND wr.revision = 2`,
      [roomId],
    );
    const treeEntry = await git(["ls-tree", workspace.rows[0]!.commit_sha, "--", "README.md"], {
      gitDir: workspace.rows[0]!.repo_path,
      timeoutMs: 10_000,
    });
    expect(treeEntry.stdout).toMatch(/^100644 blob /);
  });

  it("keeps unselected local edits out of canonical and advances the rebased sandbox base", async () => {
    const driver = new RecordingExecutionDriver();
    const { server } = await start({}, new RecordingPublisher(), { executionDriver: driver });
    const { roomId, owner, cmd } = await walkthrough(server.app, false);
    const participantId = await ownerParticipantId(roomId);
    const sandbox = await server.execution.ensure(roomId, participantId);
    driver.working.get(sandbox.id)!.set("submitted.txt", {
      mode: "100644",
      content: Buffer.from("canonical content"),
    });
    driver.working.get(sandbox.id)!.set("local.txt", {
      mode: "100644",
      content: Buffer.from("keep editing"),
    });

    const applied = await ok(
      await cmd(
        envelope("changes.submit", {
          paths: ["submitted.txt"],
          message: "Submit one file",
        }),
        owner.tokens.access_token,
      ),
    );
    expect(applied.response).toMatchObject({
      status: "APPLIED",
      applied_revision: 1,
      base_revision: 0,
      sandbox_advance: "scheduled",
    });
    expect(driver.working.get(sandbox.id)!.get("local.txt")?.content.toString()).toBe(
      "keep editing",
    );

    const workspace = await db.pool.query<{ repo_path: string; commit_sha: string }>(
      `SELECT w.repo_path, wr.commit_sha FROM workspaces w
       JOIN workspace_revisions wr ON wr.workspace_id = w.id AND wr.room_id = w.room_id
       WHERE w.room_id = $1 AND wr.revision = 1`,
      [roomId],
    );
    await expect(
      git(["cat-file", "-e", `${workspace.rows[0]!.commit_sha}:local.txt`], {
        gitDir: workspace.rows[0]!.repo_path,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();
    await expect(
      git(["cat-file", "-e", `${workspace.rows[0]!.commit_sha}:submitted.txt`], {
        gitDir: workspace.rows[0]!.repo_path,
        timeoutMs: 10_000,
      }),
    ).resolves.toBeDefined();
  });

  it("leaves human conflict markers at the new base and refuses to submit them", async () => {
    const driver = new RecordingExecutionDriver();
    const { server } = await start({}, new RecordingPublisher(), { executionDriver: driver });
    const { roomId, owner, cmd } = await walkthrough(server.app, false);
    const participantId = await ownerParticipantId(roomId);
    const sandbox = await server.execution.ensure(roomId, participantId);
    driver.working.get(sandbox.id)!.set("local.txt", {
      mode: "100644",
      content: Buffer.from("sandbox version"),
    });
    driver.working.get(sandbox.id)!.set("submitted.txt", {
      mode: "100644",
      content: Buffer.from("submitted content"),
    });
    await ok(
      await cmd(
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Concurrent canonical edit",
          base_workspace_revision: 0,
          operations: [{ type: "create", path: "local.txt", content: "canonical version" }],
        }),
        owner.tokens.access_token,
      ),
    );

    await vi.waitFor(async () => {
      expect((await server.execution.get(roomId, participantId))?.base_revision).toBe(1);
      expect(driver.working.get(sandbox.id)!.get("local.txt")?.content.toString()).toContain(
        "<<<<<<<",
      );
    });
    const rejected = await cmd(
      envelope("changes.submit", { paths: ["local.txt"], message: "Submit unresolved conflict" }),
      owner.tokens.access_token,
    );
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toMatchObject({
      code: "VALIDATION",
      details: { reason: "conflict_markers", paths: ["local.txt"] },
    });
    expect(await server.execution.get(roomId, participantId)).toMatchObject({ base_revision: 1 });
  });

  it("leaves an agent sandbox behind when local changes overlap the canonical advance", async () => {
    const driver = new RecordingExecutionDriver();
    const { server, publisher } = await start({}, new RecordingPublisher(), {
      executionDriver: driver,
    });
    const { roomId, owner, agent, cmd } = await walkthrough(server.app, false);
    const participantId = agent.participant_id as string;
    const sandbox = await server.execution.ensure(roomId, participantId);
    driver.working.get(sandbox.id)!.set("local.txt", {
      mode: "100644",
      content: Buffer.from("sandbox version"),
    });

    await ok(
      await cmd(
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Concurrent canonical edit",
          base_workspace_revision: 0,
          operations: [{ type: "create", path: "local.txt", content: "canonical version" }],
        }),
        owner.tokens.access_token,
      ),
    );
    await vi.waitFor(() => {
      expect(
        publisher.events.some(
          (event) =>
            event.room_id === roomId &&
            event.type === "sandbox.behind" &&
            event.payload.participant_id === participantId &&
            event.payload.reason === "local_changes",
        ),
      ).toBe(true);
    });

    expect(await server.execution.get(roomId, participantId)).toMatchObject({ base_revision: 0 });
    expect(driver.working.get(sandbox.id)!.get("local.txt")?.content.toString()).toBe(
      "sandbox version",
    );
  });

  it("sandbox.sync rebases non-overlapping edits onto the latest head", async () => {
    const driver = new RecordingExecutionDriver();
    const { server, publisher } = await start({}, new RecordingPublisher(), {
      executionDriver: driver,
    });
    const { roomId, owner, agent, cmd } = await walkthrough(server.app, false);
    await ok(
      await cmd(
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Create a shared file",
          base_workspace_revision: 0,
          operations: [{ type: "create", path: "local.txt", content: "one\ntwo\nthree\n" }],
        }),
        owner.tokens.access_token,
      ),
    );
    const participantId = agent.participant_id as string;
    const sandbox = await server.execution.ensure(roomId, participantId);
    driver.working.get(sandbox.id)!.set("local.txt", {
      mode: "100644",
      content: Buffer.from("ONE\ntwo\nthree\n"),
    });
    await ok(
      await cmd(
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Edit a separate line",
          base_workspace_revision: 1,
          operations: [{ type: "modify", path: "local.txt", content: "one\ntwo\nTHREE\n" }],
        }),
        owner.tokens.access_token,
      ),
    );

    const synced = await ok(await cmd(envelope("sandbox.sync"), agent.tokens.access_token));
    expect(synced.response).toEqual({ synced_to: 2 });
    expect(await server.execution.get(roomId, participantId)).toMatchObject({ base_revision: 2 });
    expect(driver.working.get(sandbox.id)!.get("local.txt")?.content.toString()).toBe(
      "ONE\ntwo\nTHREE\n",
    );
    await vi.waitFor(() => {
      expect(
        publisher.events.find(
          (event) =>
            event.room_id === roomId &&
            event.type === "sandbox.synced" &&
            event.payload.participant_id === participantId,
        ),
      ).toMatchObject({ payload: { base_revision: 2 } });
    });
  });

  it("lets another room command complete while sandbox.sync is preparing its snapshot", async () => {
    const driver = new RecordingExecutionDriver();
    const { server, publisher } = await start({}, new RecordingPublisher(), {
      executionDriver: driver,
    });
    const { roomId, owner, agent, cmd } = await walkthrough(server.app, false);
    await ok(
      await cmd(
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Create a shared file",
          base_workspace_revision: 0,
          operations: [{ type: "create", path: "local.txt", content: "one\ntwo\nthree\n" }],
        }),
        owner.tokens.access_token,
      ),
    );
    const participantId = agent.participant_id as string;
    const sandbox = await server.execution.ensure(roomId, participantId);
    driver.working.get(sandbox.id)!.set("local.txt", {
      mode: "100644",
      content: Buffer.from("ONE\ntwo\nthree\n"),
    });
    await ok(
      await cmd(
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Edit a separate line",
          base_workspace_revision: 1,
          operations: [{ type: "modify", path: "local.txt", content: "one\ntwo\nTHREE\n" }],
        }),
        owner.tokens.access_token,
      ),
    );
    await vi.waitFor(() => {
      expect(
        publisher.events.some(
          (event) =>
            event.room_id === roomId &&
            event.type === "sandbox.behind" &&
            event.payload.participant_id === participantId &&
            event.payload.reason === "local_changes",
        ),
      ).toBe(true);
    });
    await server.dispatcher.actors.get(roomId).idle();

    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => {
      markSnapshotStarted = resolve;
    });
    let releaseSnapshot!: () => void;
    const snapshotWait = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    driver.snapshotInventoryPause = { started: markSnapshotStarted, wait: snapshotWait };

    const syncing = cmd(envelope("sandbox.sync"), agent.tokens.access_token);
    try {
      await snapshotStarted;
      const messageSent = await Promise.race([
        cmd(
          envelope("messages.send", { body: "While the sandbox sync is preparing" }),
          agent.tokens.access_token,
        ).then((response) => {
          expect(response.statusCode, response.body).toBe(200);
          return "sent" as const;
        }),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
      ]);
      expect(messageSent).toBe("sent");
    } finally {
      releaseSnapshot();
    }

    const synced = await ok(await syncing);
    expect(synced.response).toEqual({ synced_to: 2 });
    expect(await server.execution.get(roomId, participantId)).toMatchObject({ base_revision: 2 });
  });

  it("sandbox.sync advances to head and leaves merge markers on conflicts", async () => {
    const driver = new RecordingExecutionDriver();
    const { server } = await start({}, new RecordingPublisher(), { executionDriver: driver });
    const { roomId, owner, agent, cmd } = await walkthrough(server.app, false);
    await ok(
      await cmd(
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Create a shared file",
          base_workspace_revision: 0,
          operations: [{ type: "create", path: "local.txt", content: "base\nsecond\n" }],
        }),
        owner.tokens.access_token,
      ),
    );
    const participantId = agent.participant_id as string;
    const sandbox = await server.execution.ensure(roomId, participantId);
    driver.working.get(sandbox.id)!.set("local.txt", {
      mode: "100644",
      content: Buffer.from("local\nsecond\n"),
    });
    await ok(
      await cmd(
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Conflicting canonical edit",
          base_workspace_revision: 1,
          operations: [{ type: "modify", path: "local.txt", content: "head\nsecond\n" }],
        }),
        owner.tokens.access_token,
      ),
    );

    const synced = await ok(await cmd(envelope("sandbox.sync"), agent.tokens.access_token));
    expect(synced.response).toEqual({ synced_to: 2, conflicted_paths: ["local.txt"] });
    expect(await server.execution.get(roomId, participantId)).toMatchObject({ base_revision: 2 });
    expect(driver.working.get(sandbox.id)!.get("local.txt")?.content.toString()).toContain(
      "<<<<<<<",
    );
  });

  it("sandbox.sync leaves the working copy alone while an exec is running", async () => {
    const driver = new RecordingExecutionDriver();
    const { server } = await start({}, new RecordingPublisher(), { executionDriver: driver });
    const { roomId, owner, agent, cmd } = await walkthrough(server.app, false);
    await ok(
      await cmd(
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Create a shared file",
          base_workspace_revision: 0,
          operations: [{ type: "create", path: "local.txt", content: "base\n" }],
        }),
        owner.tokens.access_token,
      ),
    );
    const participantId = agent.participant_id as string;
    const sandbox = await server.execution.ensure(roomId, participantId);
    driver.working.get(sandbox.id)!.set("local.txt", {
      mode: "100644",
      content: Buffer.from("base\n"),
    });
    await ok(
      await cmd(
        envelope("sandbox.exec", { command: "long-running command" }),
        agent.tokens.access_token,
      ),
    );
    await server.dispatcher.actors.get(roomId).idle();
    expect(driver.finishExec).toBeDefined();
    await ok(
      await cmd(
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Advance canonical while exec is active",
          base_workspace_revision: 1,
          operations: [{ type: "modify", path: "local.txt", content: "next\n" }],
        }),
        owner.tokens.access_token,
      ),
    );

    const blocked = await ok(await cmd(envelope("sandbox.sync"), agent.tokens.access_token));
    expect(blocked.response).toMatchObject({
      base_revision: 1,
      head_revision: 2,
      reason: "process_running",
    });
    expect(await server.execution.get(roomId, participantId)).toMatchObject({ base_revision: 1 });
    expect(driver.working.get(sandbox.id)!.get("local.txt")?.content.toString()).toBe("base\n");

    driver.finishExec?.({ exit_code: 0, duration_ms: 1, reason: "exit" });
    await vi.waitFor(async () => {
      expect((await server.execution.get(roomId, participantId))?.base_revision).toBe(2);
    });
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

  it("reads the proxy and refresh-limit settings", () => {
    expect(loadConfig(env)).toMatchObject({ trustProxy: [], refreshPerMinute: 30 });
    expect(
      loadConfig({ ...env, TRUST_PROXY: "10.0.0.0/8, 127.0.0.1", REFRESH_PER_MINUTE: "5" }),
    ).toMatchObject({
      trustProxy: ["10.0.0.0/8", "127.0.0.1"],
      refreshPerMinute: 5,
    });
    expect(() => loadConfig({ ...env, REFRESH_PER_MINUTE: "0" })).toThrow(/REFRESH_PER_MINUTE/);
    // Anything that isn't an address or CIDR is refused at boot, naming the variable.
    for (const bad of [
      "true",
      "garbage",
      "1",
      "0",
      "10.0.0.0/33",
      "::1/129",
      "10.0.0.0/8,nope",
      "1.2.3.4/",
    ]) {
      expect(() => loadConfig({ ...env, TRUST_PROXY: bad }), bad).toThrow(/TRUST_PROXY/);
    }
    expect(loadConfig({ ...env, TRUST_PROXY: "::1, 2001:db8::/32" }).trustProxy).toEqual([
      "::1",
      "2001:db8::/32",
    ]);
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
