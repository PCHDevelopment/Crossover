import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import type { EventPublisher } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { git, type UpstreamFetcher } from "@crossover/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeServer, type CrossoverServer } from "../compose.js";
import type { ServerConfig } from "../config.js";

/** `git.import` through the real server: the policy, the HTTP surface and the fetch seam. */

let db: TestDatabase;
let root: string;
let server: CrossoverServer;
let upstreamDir: string;
let upstreamSha: string;
let fetches = 0;
let remoteDir: string;
const pushed: string[] = [];
let serial = 0;
const identity = {
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const run = (cwd: string, args: string[]) => git(args, { cwd, timeoutMs: 30_000, env: identity });

const fetcher: UpstreamFetcher = {
  async fetch(request) {
    fetches += 1;
    const dir = await mkdtemp(join(tmpdir(), "crossover-e2e-fetched-"));
    await run(dir, ["clone", "-q", "--bare", upstreamDir, "repo"]);
    const repo = join(dir, "repo");
    const sha = (
      await git(["rev-parse", "HEAD"], { gitDir: repo, timeoutMs: 10_000 })
    ).stdout.trim();
    expect(request.branch).toBe("main");
    return { repo, ref: "HEAD", sha, cleanup: () => rm(dir, { recursive: true, force: true }) };
  },
};

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-git-import-e2e-"));
  upstreamDir = await mkdtemp(join(tmpdir(), "crossover-e2e-upstream-"));
  await run(upstreamDir, ["init", "-q", "-b", "main"]);
  await mkdir(join(upstreamDir, "src"), { recursive: true });
  await writeFile(join(upstreamDir, "README.md"), "# From upstream\n");
  await writeFile(join(upstreamDir, "src/main.ts"), "export const hello = 'world';\n");
  await run(upstreamDir, ["add", "-A"]);
  await run(upstreamDir, ["commit", "-q", "-m", "Initial"]);
  upstreamSha = (await run(upstreamDir, ["rev-parse", "HEAD"])).stdout.trim();
  remoteDir = await mkdtemp(join(tmpdir(), "crossover-e2e-remote-"));
  await run(remoteDir, ["init", "-q", "--bare", "-b", "main", "remote.git"]);
  remoteDir = join(remoteDir, "remote.git");
  const config: ServerConfig = {
    databaseUrl: "unused: test pool is injected",
    redisUrl: process.env["REDIS_URL"] ?? "redis://localhost:6379",
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    nodeId: `import-e2e-${process.pid}`,
    devLogin: true,
    healthImages: ["node:22-bookworm-slim"],
  };
  const publisher: EventPublisher = { publish: async () => undefined };
  server = await composeServer(config, {
    pool: db.pool,
    publisher,
    upstream: {
      fetcher,
      resolve: async () => ["93.184.216.34"],
      pusher: {
        async push(request) {
          pushed.push(request.branch);
          await git(
            ["push", "--porcelain", remoteDir, `${request.commit}:refs/heads/${request.branch}`],
            { gitDir: request.repo, timeoutMs: 30_000 },
          );
        },
      },
    },
  });
});

afterAll(async () => {
  await server?.close();
  await db?.drop();
  await Promise.all([root, upstreamDir].map((d) => d && rm(d, { recursive: true, force: true })));
});

const envelope = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `import-e2e-${++serial}`,
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
    await post("/v1/auth/dev-login", { subject: `imp-${newId("usr")}`, display_name: "Owner" }),
  );
  const created = await ok(
    await post(
      "/v1/commands",
      envelope("room.create", {
        slug: `imp-${++serial}`,
        name: "Import",
        objective: "Bring the code",
      }),
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
  const dev = (
    await ok(
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
    )
  ).tokens.access_token as string;
  const call = (token: string, method: string, params: Record<string, unknown> = {}) =>
    post(`/v1/rooms/${roomId}/commands`, envelope(method, params), token);
  return { roomId, owner, dev, call };
}

describe("git.import over HTTP", () => {
  it("the owner imports a public upstream: revision 1 holds its files, readable at once", async () => {
    const r = await newRoom();
    const out = await ok(
      await r.call(r.owner, "git.import", {
        url: "https://github.com/acme/widgets",
        branch: "main",
      }),
    );
    expect(out.response).toMatchObject({
      applied_revision: 1,
      file_count: 2,
      upstream: {
        url: "https://github.com/acme/widgets",
        branch: "main",
        last_synced_sha: upstreamSha,
        last_synced_room_revision: 1,
      },
    });
    const read = await ok(await r.call(r.dev, "workspace.read", { path: "src/main.ts" }));
    expect(read.response.content).toBe("export const hello = 'world';\n");
    const events = (await ok(await r.call(r.owner, "room.events.list"))).response.events as {
      type: string;
    }[];
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["workspace.changeset.applied", "workspace.upstream_synced"]),
    );
  });

  it("a developer can't import: FORBIDDEN, nothing fetched", async () => {
    const r = await newRoom();
    const before = fetches;
    const res = await r.call(r.dev, "git.import", {
      url: "https://github.com/acme/widgets",
      branch: "main",
    });
    expect(res.statusCode).toBe(403);
    expect(fetches).toBe(before);
  });

  it("an import into a room that already has history is a 400, and a private host is refused", async () => {
    const r = await newRoom();
    await ok(
      await r.call(r.owner, "git.import", {
        url: "https://github.com/acme/widgets",
        branch: "main",
      }),
    );
    const again = await r.call(r.owner, "git.import", {
      url: "https://github.com/acme/widgets",
      branch: "main",
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.details.reason).toBe("workspace_not_empty");

    const fresh = await newRoom();
    const local = await fresh.call(fresh.owner, "git.import", {
      url: "https://127.0.0.1/acme/widgets",
      branch: "main",
    });
    expect(local.statusCode).toBe(400);
    expect(local.json().error.details.reason).toBe("url_host");
  });
});

describe("git.pull_upstream over HTTP", () => {
  it("the owner pulls what changed upstream; a developer can't, and nothing is fetched for them", async () => {
    const r = await newRoom();
    await ok(
      await r.call(r.owner, "git.import", {
        url: "https://github.com/acme/widgets",
        branch: "main",
      }),
    );
    await writeFile(join(upstreamDir, "src/main.ts"), "export const hello = 'again';\n");
    await run(upstreamDir, ["commit", "-q", "-am", "Change"]);
    const newSha = (await run(upstreamDir, ["rev-parse", "HEAD"])).stdout.trim();

    const before = fetches;
    const denied = await r.call(r.dev, "git.pull_upstream");
    expect(denied.statusCode).toBe(403);
    expect(fetches).toBe(before);

    const out = await ok(await r.call(r.owner, "git.pull_upstream"));
    expect(out.response).toMatchObject({
      status: "APPLIED",
      applied_revision: 2,
      upstream: { last_synced_sha: newSha, last_synced_room_revision: 2 },
    });
    const read = await ok(await r.call(r.dev, "workspace.read", { path: "src/main.ts" }));
    expect(read.response.content).toBe("export const hello = 'again';\n");
    const again = await ok(await r.call(r.owner, "git.pull_upstream"));
    expect(again.response.status).toBe("UP_TO_DATE");
  });
});

describe("checkpoints over HTTP", () => {
  it("the owner marks the head; a developer can't, but can list; an override is the owner's alone", async () => {
    const r = await newRoom();
    const empty = await r.call(r.owner, "checkpoints.create", { message: "too early" });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.details.reason).toBe("empty_workspace");
    await ok(
      await r.call(r.owner, "git.import", {
        url: "https://github.com/acme/widgets",
        branch: "main",
      }),
    );
    const denied = await r.call(r.dev, "checkpoints.create", { message: "nope" });
    expect(denied.statusCode).toBe(403);
    const made = await ok(await r.call(r.owner, "checkpoints.create", { message: "imported" }));
    expect(made.response).toMatchObject({ revision: 1, message: "imported", overridden: false });
    const list = await ok(await r.call(r.dev, "checkpoints.list"));
    expect(list.response.checkpoints).toHaveLength(1);
    expect(list.response.checkpoints[0].provenance.author_kind).toBe("HUMAN");
  });
});

describe("checkpoints when the owner isn't the lead", () => {
  it("an owner who handed the lead to an agent still marks a checkpoint, and is the only one who can override", async () => {
    const r = await newRoom();
    await ok(
      await r.call(r.owner, "git.import", {
        url: "https://github.com/acme/widgets",
        branch: "main",
      }),
    );
    const devId = (
      await db.pool.query("SELECT id FROM participants WHERE room_id = $1 AND kind = 'AGENT'", [
        r.roomId,
      ])
    ).rows[0].id as string;
    await ok(await r.call(r.owner, "room.set_lead", { participant_id: devId }));
    // A red health run on the head.
    await db.pool.query(
      'UPDATE rooms SET settings = settings || \'{"health_command":"npm test"}\'::jsonb WHERE id = $1',
      [r.roomId],
    );
    await db.pool.query(
      `INSERT INTO health_runs (id, workspace_id, room_id, revision, status, duration_ms, log)
       SELECT $1, workspace_id, room_id, revision, 'RED', 1, 'log' FROM workspace_revisions
       WHERE room_id = $2 AND revision = 1`,
      [newId("health"), r.roomId],
    );
    const blocked = await r.call(r.owner, "checkpoints.create", { message: "try" });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error.details.reason).toBe("health_red");
    const lead = await r.call(r.dev, "checkpoints.create", { message: "lead", override: true });
    expect(lead.statusCode).toBe(403);
    const made = await ok(
      await r.call(r.owner, "checkpoints.create", { message: "owner override", override: true }),
    );
    expect(made.response).toMatchObject({ health_status: "RED", overridden: true });
  });
});

describe("checkpoints.export over HTTP", () => {
  it("the owner exports a checkpoint to room/<slug>; a developer can't; only room/* branches are accepted", async () => {
    const r = await newRoom();
    await ok(
      await r.call(r.owner, "git.import", {
        url: "https://github.com/acme/widgets",
        branch: "main",
      }),
    );
    const made = await ok(await r.call(r.owner, "checkpoints.create", { message: "imported" }));

    const denied = await r.call(r.dev, "checkpoints.export", { checkpoint_id: made.response.id });
    expect(denied.statusCode).toBe(403);
    expect(pushed).toEqual([]);
    const wrong = await r.call(r.owner, "checkpoints.export", { branch: "main" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.details.reason).toBe("branch_not_allowed");
    expect(pushed).toEqual([]);

    const out = await ok(await r.call(r.owner, "checkpoints.export", {}));
    const slug = (await db.pool.query("SELECT slug FROM rooms WHERE id = $1", [r.roomId])).rows[0]
      .slug as string;
    expect(out.response).toMatchObject({
      checkpoint_id: made.response.id,
      branch: `room/${slug}`,
      mode: "squashed",
      commit_count: 1,
    });
    expect(pushed).toEqual([`room/${slug}`]);
    const events = (await ok(await r.call(r.owner, "room.events.list", { limit: 500 }))).response
      .events as { type: string }[];
    expect(events.map((e) => e.type)).toContain("checkpoint.exported");
  });
});
