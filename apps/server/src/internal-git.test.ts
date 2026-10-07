import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { allowAll, Dispatcher, type Authorizer } from "@crossover/kernel";
import { CrossoverError, newId } from "@crossover/protocol";
import { buildGateway } from "@crossover/gateway";
import { createSandboxReadToken } from "@crossover/security";
import { git } from "@crossover/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildInternalGitServer } from "./internal-git.js";

const TOKEN_SECRET = "internal-git-test-secret-that-is-long-enough-32-bytes";
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Crossover test",
  GIT_AUTHOR_EMAIL: "test@crossover.invalid",
  GIT_COMMITTER_NAME: "Crossover test",
  GIT_COMMITTER_EMAIL: "test@crossover.invalid",
};

let db: TestDatabase;
let root: string;
let repoPath: string;
let roomId: string;
let participantId: string;
let sandboxId: string;
let canonicalCommit: string;
let secretBlob: string;
let internalGit: ReturnType<typeof buildInternalGitServer>;
let publicGateway: ReturnType<typeof buildGateway>;
let remoteBase: string;
let token: string;

const authorizeScopedRead: Authorizer = async (_principal, _action, resource) => {
  if (resource.path === "private/secret.txt")
    throw new CrossoverError("FORBIDDEN", "Path is outside this participant's read scope");
  if (resource.path === undefined)
    throw new CrossoverError("FORBIDDEN", "Participant has path-scoped workspace access");
};

beforeAll(async () => {
  db = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), "crossover-internal-git-test-"));
  const working = join(root, "working");
  repoPath = join(root, "room.git");
  await mkdir(working, { recursive: true });
  await git(["init", "-q", "-b", "main"], { cwd: working, timeoutMs: 10_000 });
  await git(["config", "user.name", "Crossover test"], { cwd: working, timeoutMs: 10_000 });
  await git(["config", "user.email", "test@crossover.invalid"], {
    cwd: working,
    timeoutMs: 10_000,
  });
  await writeFile(join(working, "public.txt"), "visible in the sandbox\n");
  await git(["add", "-A"], { cwd: working, timeoutMs: 10_000 });
  await git(["commit", "-q", "-m", "first canonical revision"], {
    cwd: working,
    timeoutMs: 10_000,
    env: GIT_IDENTITY,
  });
  await mkdir(join(working, "private"), { recursive: true });
  await writeFile(join(working, "private", "secret.txt"), "must never reach the sandbox\n");
  await git(["add", "-A"], { cwd: working, timeoutMs: 10_000 });
  await git(["commit", "-q", "-m", "canonical commit message stays private"], {
    cwd: working,
    timeoutMs: 10_000,
    env: GIT_IDENTITY,
  });
  canonicalCommit = (
    await git(["rev-parse", "HEAD"], { cwd: working, timeoutMs: 10_000 })
  ).stdout.trim();
  secretBlob = (
    await git(["rev-parse", "HEAD:private/secret.txt"], { cwd: working, timeoutMs: 10_000 })
  ).stdout.trim();
  await git(["clone", "-q", "--bare", working, repoPath], { timeoutMs: 10_000 });
  await git(["update-ref", "refs/room/canonical", canonicalCommit], {
    gitDir: repoPath,
    timeoutMs: 10_000,
  });

  roomId = newId("room");
  participantId = newId("part");
  sandboxId = newId("sandbox");
  const workspaceId = newId("ws");
  await db.pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id)
     VALUES ($1, $2, 'Internal Git test', 'Verify scoped workspace fetch', $3)`,
    [roomId, `git-${roomId}`, newId("usr")],
  );
  await db.pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'AGENT', 'Git test agent', 'MEMBER', 'DEVELOPER', 'ACTIVE')`,
    [participantId, roomId],
  );
  await db.pool.query("INSERT INTO workspaces (id, room_id, repo_path) VALUES ($1, $2, $3)", [
    workspaceId,
    roomId,
    repoPath,
  ]);
  await db.pool.query(
    `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
     VALUES ($1, $2, 1, $3)`,
    [workspaceId, roomId, canonicalCommit],
  );
  await db.pool.query(
    `INSERT INTO sandboxes (id, room_id, participant_id, status, volume_ref, container_ref)
     VALUES ($1, $2, $3, 'RUNNING', $4, $5)`,
    [sandboxId, roomId, participantId, `volume-${sandboxId}`, `container-${sandboxId}`],
  );

  token = createSandboxReadToken(
    {
      room_id: roomId,
      participant_id: participantId,
      sandbox_id: sandboxId,
      revision: 1,
      expires_at: Date.now() + 120_000,
    },
    TOKEN_SECRET,
  );
  internalGit = buildInternalGitServer({
    pool: db.pool,
    authorize: authorizeScopedRead,
    tokenSecret: TOKEN_SECRET,
  });
  remoteBase = await internalGit.listen({ host: "127.0.0.1", port: 0 });

  const dispatcher = new Dispatcher({
    pool: db.pool,
    authorize: allowAll,
    nodeId: "public-api-test",
  });
  publicGateway = buildGateway({ dispatcher, pool: db.pool });
});

afterAll(async () => {
  await publicGateway?.close();
  await internalGit?.close();
  await db?.drop();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("internal Git workspace reads", () => {
  it("materializes a scoped clone without storing excluded blobs", async () => {
    const target = join(root, "cloned-workspace");
    await mkdir(target, { recursive: true });
    await cloneWorkspace(target, remoteBase, token);

    expect(await readFile(join(target, "public.txt"), "utf8")).toBe("visible in the sandbox\n");
    await expect(readFile(join(target, "private/secret.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      git(["cat-file", "-e", secretBlob], { cwd: target, timeoutMs: 10_000 }),
    ).rejects.toThrow();
    expect(
      (
        await git(["rev-list", "--count", "HEAD"], { cwd: target, timeoutMs: 10_000 })
      ).stdout.trim(),
    ).toBe("1");
    expect(
      (
        await git(["show", "-s", "--format=%B", "HEAD"], { cwd: target, timeoutMs: 10_000 })
      ).stdout.trim(),
    ).toBe("Crossover sandbox snapshot");
    expect(canonicalCommit).not.toBe(
      (await git(["rev-parse", "HEAD"], { cwd: target, timeoutMs: 10_000 })).stdout.trim(),
    );
    await expect(
      readFile(join(target, ".git/objects/info/alternates"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    { protocol: "0", description: "canonical commit", object: () => canonicalCommit },
    { protocol: "0", description: "out-of-scope blob", object: () => secretBlob },
    { protocol: "2", description: "canonical commit", object: () => canonicalCommit },
    { protocol: "2", description: "out-of-scope blob", object: () => secretBlob },
  ])(
    "does not serve a $description by object ID over protocol v$protocol",
    async ({ protocol, object }) => {
      const target = join(root, `want-${protocol}-${object()}`);
      await mkdir(target, { recursive: true });
      await git(["init", "--quiet"], { cwd: target, timeoutMs: 10_000 });
      const remote = `${new URL(remoteBase).origin}/git/${roomId}/${sandboxId}/1`;

      await expect(
        git(["-c", `protocol.version=${protocol}`, "fetch", "--depth=1", remote, object()], {
          cwd: target,
          timeoutMs: 20_000,
          env: {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "http.extraHeader",
            GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        }),
      ).rejects.toThrow();
      await expect(
        git(["cat-file", "-e", object()], { cwd: target, timeoutMs: 10_000 }),
      ).rejects.toThrow();
    },
  );

  it("gives an unscoped reader the real canonical commit with shallow history", async () => {
    const unscopedGit = buildInternalGitServer({
      pool: db.pool,
      authorize: allowAll,
      tokenSecret: TOKEN_SECRET,
    });
    const address = await unscopedGit.listen({ host: "127.0.0.1", port: 0 });
    const target = join(root, "unscoped-workspace");
    await mkdir(target, { recursive: true });
    try {
      await cloneWorkspace(target, address, token);
      expect(
        (await git(["rev-parse", "HEAD"], { cwd: target, timeoutMs: 10_000 })).stdout.trim(),
      ).toBe(canonicalCommit);
      expect(
        (
          await git(["rev-list", "--count", "HEAD"], { cwd: target, timeoutMs: 10_000 })
        ).stdout.trim(),
      ).toBe("1");
      expect(
        (
          await git(["rev-list", "--count", canonicalCommit], {
            gitDir: repoPath,
            timeoutMs: 10_000,
          })
        ).stdout.trim(),
      ).toBe("2");
      expect(await readFile(join(target, ".git/shallow"), "utf8")).toContain(canonicalCommit);
    } finally {
      await unscopedGit.close();
    }
  });

  it("rejects a token issued for another room", async () => {
    const otherRoomToken = createSandboxReadToken(
      {
        room_id: newId("room"),
        participant_id: participantId,
        sandbox_id: sandboxId,
        revision: 1,
        expires_at: Date.now() + 120_000,
      },
      TOKEN_SECRET,
    );
    const response = await internalGit.inject({
      method: "GET",
      url: `/git/${roomId}/${sandboxId}/1/info/refs?service=git-upload-pack`,
      headers: { authorization: `Bearer ${otherRoomToken}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a token when the URL requests a different workspace revision", async () => {
    const response = await internalGit.inject({
      method: "GET",
      url: `/git/${roomId}/${sandboxId}/2/info/refs?service=git-upload-pack`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("refuses receive-pack and non-Git routes", async () => {
    const push = await internalGit.inject({
      method: "POST",
      url: `/git/${roomId}/${sandboxId}/1/git-receive-pack`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-git-receive-pack-request",
      },
      payload: "",
    });
    const other = await internalGit.inject({ method: "GET", url: "/health" });
    expect(push.statusCode).toBe(404);
    expect(other.statusCode).toBe(404);
  });

  it("does not accept an internal read token on the public API", async () => {
    const response = await publicGateway.inject({
      method: "POST",
      url: `/v1/rooms/${roomId}/commands`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: JSON.stringify({
        id: newId("cmd"),
        method: "unknown.command",
        params: {},
        idempotency_key: newId("cmd"),
      }),
    });
    expect(response.statusCode).toBe(401);
  });
});

async function cloneWorkspace(target: string, remote: string, readToken: string): Promise<void> {
  const base = new URL(remote);
  await git(
    [
      "clone",
      "--quiet",
      "--no-tags",
      "--depth=1",
      "--single-branch",
      "--branch",
      "main",
      `--reference=${repoPath}`,
      "--dissociate",
      `${base.origin}/git/${roomId}/${sandboxId}/1`,
      target,
    ],
    {
      timeoutMs: 30_000,
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Bearer ${readToken}`,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
}
