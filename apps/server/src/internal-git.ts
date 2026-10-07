import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import type { Pool } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import type { Authorizer, Principal } from "@crossover/kernel";
import { verifySandboxReadToken, type SandboxReadTokenClaims } from "@crossover/security";
import {
  createScopedSnapshotRepository,
  createUnscopedSnapshotRepository,
  git,
  type ScopedSnapshotRepository,
} from "@crossover/workspace";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { join } from "node:path";

const UPLOAD_PACK_REQUEST = "application/x-git-upload-pack-request";
const UPLOAD_PACK_RESULT = "application/x-git-upload-pack-result";
const ADVERTISEMENT = "application/x-git-upload-pack-advertisement";
const MAX_NEGOTIATION_BYTES = 4 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const BEARER = /^Bearer ([^\s]+)$/i;

interface GitRouteParams {
  roomId: string;
  sandboxId: string;
  revision: string;
}

interface GitRouteQuery {
  service?: string;
}

interface GitSnapshotRow {
  room_id: string;
  participant_id: string;
  sandbox_id: string;
  participant_status: string;
  room_status: string;
  kind: Principal["kind"];
  authority: Principal["authority"];
  role: Principal["role"];
  repo_path: string;
  revision: string;
  commit_sha: string;
}

export interface InternalGitOptions {
  pool: Pool;
  authorize: Authorizer;
  /** Missing secret keeps the listener closed with 503 responses. */
  tokenSecret?: string;
}

/** A separate, read-only smart-Git listener for short-lived sandbox fetchers. */
export function buildInternalGitServer(options: InternalGitOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: MAX_NEGOTIATION_BYTES });
  app.addContentTypeParser(
    UPLOAD_PACK_REQUEST,
    { parseAs: "buffer", bodyLimit: MAX_NEGOTIATION_BYTES },
    (_request, body, done) => done(null, body),
  );
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: "Not found" }));
  app.setErrorHandler((error, request, reply) => {
    const status = errorStatus(error);
    if (status === 500) console.error("[internal-git] request failed", error);
    if (status === 401) void reply.header("WWW-Authenticate", "Bearer");
    return reply
      .status(status)
      .header("Cache-Control", "no-store")
      .send({ error: status === 404 ? "Not found" : "Git request refused" });
  });

  app.get<{ Params: GitRouteParams; Querystring: GitRouteQuery }>(
    "/git/:roomId/:sandboxId/:revision/info/refs",
    async (request, reply) => {
      if (request.query.service !== "git-upload-pack")
        throw new CrossoverError("NOT_FOUND", "Git service not found");
      const revision = parseRevision(request.params.revision);
      const snapshot = await prepareSnapshot(options, request, revision);
      try {
        const protocol = requestedProtocol(request);
        const { stdout } = await git(
          ["upload-pack", "--stateless-rpc", "--advertise-refs", snapshot.repo_path],
          {
            timeoutMs: GIT_TIMEOUT_MS,
            maxBuffer: 2 * 1024 * 1024,
            env: {
              ...alternateEnvironment(snapshot),
              ...(protocol ? { GIT_PROTOCOL: protocol } : {}),
            },
          },
        );
        const service = packetLine("# service=git-upload-pack\n");
        void reply
          .header("Content-Type", ADVERTISEMENT)
          .header("Cache-Control", "no-cache, no-store")
          .header("Pragma", "no-cache")
          .header("Expires", "Fri, 01 Jan 1980 00:00:00 GMT");
        return Buffer.concat([service, Buffer.from("0000"), Buffer.from(stdout)]);
      } finally {
        await snapshot.dispose();
      }
    },
  );

  app.post<{ Params: GitRouteParams; Querystring: GitRouteQuery }>(
    "/git/:roomId/:sandboxId/:revision/git-upload-pack",
    async (request, reply) => {
      const revision = parseRevision(request.params.revision);
      if (!Buffer.isBuffer(request.body))
        throw new CrossoverError("VALIDATION", "Invalid Git request body");
      const snapshot = await prepareSnapshot(options, request, revision);
      return streamUploadPack(snapshot, request, reply, request.body);
    },
  );

  return app;
}

async function prepareSnapshot(
  options: InternalGitOptions,
  request: FastifyRequest<{ Params: GitRouteParams; Querystring: GitRouteQuery }>,
  revision: number,
): Promise<ScopedSnapshotRepository> {
  if (!options.tokenSecret || Buffer.byteLength(options.tokenSecret) < 32)
    throw new CrossoverError("ROOM_PAUSED", "Internal Git is not configured");
  const match = request.headers.authorization?.match(BEARER);
  const claims = match?.[1] ? verifySandboxReadToken(match[1], options.tokenSecret) : null;
  if (
    !claims ||
    claims.room_id !== request.params.roomId ||
    claims.sandbox_id !== request.params.sandboxId
  ) {
    throw new CrossoverError("UNAUTHENTICATED", "Invalid sandbox read token");
  }
  return prepareAuthorizedSnapshot(options, claims, revision);
}

async function prepareAuthorizedSnapshot(
  options: InternalGitOptions,
  claims: SandboxReadTokenClaims,
  revision: number,
): Promise<ScopedSnapshotRepository> {
  const client = await options.pool.connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    const { rows } = await client.query<GitSnapshotRow>(
      `SELECT s.room_id, s.participant_id, s.id AS sandbox_id,
              p.status AS participant_status, r.status AS room_status,
              p.kind, p.authority, p.role, w.repo_path, wr.revision, wr.commit_sha
       FROM sandboxes s
       JOIN participants p ON p.id = s.participant_id AND p.room_id = s.room_id
       JOIN rooms r ON r.id = s.room_id
       JOIN workspaces w ON w.room_id = s.room_id
       JOIN workspace_revisions wr ON wr.workspace_id = w.id AND wr.room_id = w.room_id
       WHERE s.id = $1 AND s.room_id = $2 AND s.participant_id = $3
         AND s.status NOT IN ('DESTROYING', 'DESTROYED')
         AND p.status = 'ACTIVE' AND r.status = 'ACTIVE' AND wr.revision = $4`,
      [claims.sandbox_id, claims.room_id, claims.participant_id, revision],
    );
    const row = rows[0];
    if (!row) throw new CrossoverError("NOT_FOUND", "Sandbox workspace not found");

    const principal: Principal = {
      participant_id: row.participant_id,
      room_id: row.room_id,
      kind: row.kind,
      authority: row.authority,
      role: row.role,
    };
    const context = { method: "workspace.read", params: {}, client };
    let hasUnscopedRead = true;
    try {
      await options.authorize(principal, "workspace.read", { room_id: row.room_id }, context);
    } catch (error) {
      if (!isForbidden(error)) throw error;
      hasUnscopedRead = false;
    }

    const timestamp = Number(
      (
        await git(["show", "-s", "--format=%ct", row.commit_sha], {
          gitDir: row.repo_path,
          timeoutMs: GIT_TIMEOUT_MS,
        })
      ).stdout.trim(),
    );
    const tree = await git(["ls-tree", "-r", "-z", "--full-tree", row.commit_sha], {
      gitDir: row.repo_path,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    const allEntries = tree.stdout.split("\0").filter(Boolean);
    const readablePaths = new Set<string>();
    for (const entry of allEntries) {
      const tab = entry.indexOf("\t");
      if (tab < 0) throw new Error("Git returned a malformed tree entry");
      const path = entry.slice(tab + 1);
      try {
        await options.authorize(
          principal,
          "workspace.read",
          { room_id: row.room_id, path },
          { ...context, params: { path } },
        );
        readablePaths.add(path);
      } catch (error) {
        if (isForbidden(error)) continue;
        throw error;
      }
    }
    if (hasUnscopedRead && readablePaths.size === allEntries.length)
      return createUnscopedSnapshotRepository({
        referenceRepository: row.repo_path,
        canonicalCommit: row.commit_sha,
      });

    return createScopedSnapshotRepository({
      referenceRepository: row.repo_path,
      canonicalCommit: row.commit_sha,
      revision: Number(row.revision),
      canonicalTimestamp: timestamp,
      canRead: async (path) => readablePaths.has(path),
    });
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK").catch(() => undefined);
      transactionOpen = false;
    }
    throw error;
  } finally {
    if (transactionOpen) await client.query("COMMIT").catch(() => undefined);
    client.release();
  }
}

function streamUploadPack(
  snapshot: ScopedSnapshotRepository,
  request: FastifyRequest,
  reply: FastifyReply,
  body: Buffer,
) {
  const env = gitProcessEnvironment(alternateEnvironment(snapshot));
  const protocol = requestedProtocol(request);
  if (protocol) env["GIT_PROTOCOL"] = protocol;

  const child = spawn("git", ["upload-pack", "--stateless-rpc", snapshot.repo_path], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const output = new PassThrough();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 4 * 60 * 1000);
  timeout.unref();
  child.on("error", (error) => output.destroy(error));
  child.on("close", () => {
    clearTimeout(timeout);
    void snapshot
      .dispose()
      .catch((error: unknown) =>
        console.error("[internal-git] failed to remove snapshot repository", error),
      );
  });
  request.raw.on("aborted", () => child.kill("SIGKILL"));
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) child.kill("SIGKILL");
  });
  child.stdin.on("error", () => {});
  child.stdout.pipe(output);
  child.stdin.end(body);
  void reply
    .header("Content-Type", UPLOAD_PACK_RESULT)
    .header("Cache-Control", "no-cache, no-store")
    .header("Pragma", "no-cache");
  return reply.send(output);
}

function alternateEnvironment(snapshot: ScopedSnapshotRepository): NodeJS.ProcessEnv {
  return {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(snapshot.reference_repository, "objects"),
  };
}

function gitProcessEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
    ),
    ...extra,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function parseRevision(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value))
    throw new CrossoverError("VALIDATION", "A workspace revision is required");
  const revision = Number(value);
  if (!Number.isSafeInteger(revision))
    throw new CrossoverError("VALIDATION", "Invalid workspace revision");
  return revision;
}

function packetLine(value: string): Buffer {
  const content = Buffer.from(value);
  const length = (content.length + 4).toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(length), content]);
}

function requestedProtocol(request: FastifyRequest): string | undefined {
  const protocol = request.headers["git-protocol"];
  return typeof protocol === "string" && /^version=[12]$/.test(protocol) ? protocol : undefined;
}

function isForbidden(error: unknown): boolean {
  return error instanceof CrossoverError && error.code === "FORBIDDEN";
}

function errorStatus(error: unknown): number {
  if (!(error instanceof CrossoverError)) return 500;
  const statuses: Partial<Record<CrossoverError["code"], number>> = {
    UNAUTHENTICATED: 401,
    FORBIDDEN: 404,
    NOT_FOUND: 404,
    VALIDATION: 400,
    APPROVAL_REQUIRED: 404,
    PARTICIPANT_PAUSED: 404,
    ROOM_PAUSED: 404,
  };
  return statuses[error.code] ?? 500;
}
