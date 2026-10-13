import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const image = process.env["CROSSOVER_SERVER_IMAGE"];
const GIT_NETWORK = "crossover-git";
const DOCKER_TIMEOUT_MS = 15_000;
const HEALTH_TOPOLOGY_TIMEOUT_MS = 85_000;
// Ordinary requests answer in 10-150 ms on an idle runner; 10 s leaves two orders of magnitude.
const REQUEST_BUDGET_MS = 10_000;
// The first sandbox.exec creates the sandbox and fetches the workspace through crossover-git in the
// one request: about 3.7 s on an idle runner, over 10 s on a busy one (T1522). The command's own
// timeout_s is 30, so the request may run that long plus 15 s of setup before the test calls it hung.
const FIRST_EXEC_TIMEOUT_S = 30;
const FIRST_EXEC_BUDGET_MS = (FIRST_EXEC_TIMEOUT_S + 15) * 1000;
const run = (binary: string, args: string[]) =>
  execFileAsync(binary, args, {
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
const docker = async (args: string[]) => (await run("docker", args)).stdout.trim();

let db: TestDatabase | undefined;
let workspaceRoot = "";
let containerName = "";
let baseUrl = "";
let roomId = "";
let containerCreated = false;

const envelope = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `deploy-topology-${randomBytes(12).toString("hex")}`,
});

async function requestJson<T>(
  path: string,
  body?: unknown,
  token?: string,
  expectedStatus = 200,
  budgetMs = REQUEST_BUDGET_MS,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await requestJsonWithin<T>(path, body, token, expectedStatus, budgetMs);
  } finally {
    // In the CI log, so the next budget is set from measurements and not from a guess.
    console.error(
      `[deploy-topology] ${path} took ${Date.now() - startedAt} ms (budget ${budgetMs})`,
    );
  }
}

async function requestJsonWithin<T>(
  path: string,
  body: unknown,
  token: string | undefined,
  expectedStatus: number,
  budgetMs: number,
): Promise<T> {
  const headers = {
    ...(body === undefined ? {} : { "content-type": "application/json" }),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(`${baseUrl}${path}`, {
    ...(body === undefined
      ? { method: "GET" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    ...(Object.keys(headers).length ? { headers } : {}),
    signal: AbortSignal.timeout(budgetMs),
  });
  const text = await response.text();
  if (response.status !== expectedStatus)
    throw new Error(`${path} returned ${response.status}, expected ${expectedStatus}: ${text}`);
  return JSON.parse(text) as T;
}

async function ensureGitNetwork(): Promise<void> {
  try {
    await docker(["network", "create", "--internal", "--label", "crossover.git=true", GIT_NETWORK]);
  } catch {
    // The shared network may already exist; its required internal setting is checked below.
  }
  const internal = await docker(["network", "inspect", "--format", "{{.Internal}}", GIT_NETWORK]);
  if (internal !== "true") throw new Error(`${GIT_NETWORK} exists but is not internal`);
}

async function waitFor<T>(label: string, read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 60_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (ready(value)) return value;
      last = JSON.stringify(value) ?? String(value);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} timed out; last observation: ${last}`);
}

describe.skipIf(!image)("deployed server topology", () => {
  beforeAll(async () => {
    db = await createTestDatabase();
    workspaceRoot = await mkdtemp(join(tmpdir(), "crossover-deploy-topology-"));
    await chmod(workspaceRoot, 0o777);
    await ensureGitNetwork();
    containerName = `crossover-deploy-${process.pid}-${randomBytes(4).toString("hex")}`;
    const dbUrl = new URL(process.env["DATABASE_URL"]!);
    dbUrl.hostname = "host.docker.internal";
    dbUrl.pathname = `/${db.name}`;
    const redisUrl = new URL(process.env["REDIS_URL"] ?? "redis://localhost:6379");
    redisUrl.hostname = "host.docker.internal";
    const socketGroup = (await run("stat", ["-c", "%g", "/var/run/docker.sock"])).stdout.trim();
    await docker([
      "container",
      "create",
      "--name",
      containerName,
      "--hostname",
      containerName,
      "--label",
      "crossover.test.deploy-topology=true",
      "--network",
      GIT_NETWORK,
      "--publish",
      "127.0.0.1::8080",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--group-add",
      socketGroup,
      "--mount",
      "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
      "--mount",
      `type=bind,source=${workspaceRoot},target=${workspaceRoot}`,
      "--env",
      `DATABASE_URL=${dbUrl.toString()}`,
      "--env",
      `REDIS_URL=${redisUrl.toString()}`,
      "--env",
      `WORKSPACE_ROOT=${workspaceRoot}`,
      "--env",
      "HOST=0.0.0.0",
      "--env",
      "PORT=8080",
      "--env",
      "DEV_LOGIN=true",
      "--env",
      "DEV_LOGIN_ALLOW_PRODUCTION=true", // explicit opt-in for this disposable topology fixture
      "--env",
      "INTEGRATION_KMS_KEY_ID=alias/crossover-deploy-topology-test",
      "--env",
      "SANDBOX_DISK_ENFORCEMENT=soft",
      "--env",
      `GIT_INTERNAL_HOST=${containerName}`,
      "--env",
      `GIT_INTERNAL_CONTAINER=${containerName}`,
      "--env",
      `GIT_INTERNAL_TOKEN_SECRET=${randomBytes(32).toString("hex")}`,
      "--env",
      "GIT_FETCHER_IMAGE=crossover-git-fetcher:test",
      image!,
    ]);
    containerCreated = true;
    await docker(["network", "connect", "bridge", containerName]);
    await docker(["container", "start", containerName]);
    const port = await docker([
      "container",
      "inspect",
      "--format",
      '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}',
      containerName,
    ]);
    baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(
      "deployed server health endpoint",
      async () => fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) }),
      (response) => response.status === 200,
    );
  }, 90_000);

  afterAll(async () => {
    if (containerCreated) {
      try {
        const logs = await run("docker", ["logs", "--tail", "200", containerName]);
        const output = [logs.stdout.trim(), logs.stderr.trim()].filter(Boolean).join("\n");
        console.error(`[deploy-topology] server container ${containerName} logs:\n${output}`);
      } catch (error) {
        console.error(`[deploy-topology] could not read logs for ${containerName}:`, error);
      }
    }
    if (roomId) {
      let ids: string[] = [];
      try {
        ids = (
          await docker([
            "container",
            "ls",
            "--all",
            "--quiet",
            "--filter",
            `label=crossover.room=${roomId}`,
          ])
        )
          .split(/\r?\n/)
          .filter(Boolean);
      } catch {
        // Continue cleanup of the exact server container and local test resources.
      }
      const volumes = new Set<string>();
      for (const id of ids) {
        try {
          const names = await docker([
            "container",
            "inspect",
            "--format",
            '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\\n"}}{{end}}{{end}}',
            id,
          ]);
          for (const name of names.split(/\r?\n/).filter(Boolean)) volumes.add(name);
        } catch {
          // Container removal below is still scoped to this generated room ID.
        }
      }
      if (ids.length) await docker(["container", "rm", "--force", ...ids]).catch(() => {});
      if (volumes.size) await docker(["volume", "rm", "--force", ...volumes]).catch(() => {});
    }
    if (containerCreated)
      await docker(["container", "rm", "--force", containerName]).catch(() => {});
    await db?.drop();
    if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
  }, 30_000);

  // Measured (T1534): idle 8,976 ms, 3x load 11,679 ms; budget 7x rounded up to 85,000 ms.
  it(
    "uses host-visible health checkouts and fetches a canonical workspace through crossover-git",
    async () => {
      const login = await requestJson<{ session_token: string }>("/v1/auth/dev-login", {
        subject: `deploy-topology-${randomBytes(8).toString("hex")}`,
        display_name: "Deploy topology test",
      });
      const created = await requestJson<{ response: { room: { id: string } } }>(
        "/v1/commands",
        envelope("room.create", {
          slug: `deploy-${randomBytes(6).toString("hex")}`,
          name: "Deployed server fetch",
          objective: "Verify the server-to-fetcher network topology",
        }),
        login.session_token,
      );
      roomId = created.response.room.id;
      const session = await requestJson<{
        tokens: { access_token: string };
      }>(`/v1/rooms/${roomId}/session`, {}, login.session_token);
      const token = session.tokens.access_token;
      await requestJson(
        `/v1/rooms/${roomId}/commands`,
        envelope("room.set_health", { health_command: "node --check index.js" }),
        token,
      );
      await requestJson(
        `/v1/rooms/${roomId}/commands`,
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Add files for deployed health and fetch tests",
          base_workspace_revision: 0,
          operations: [
            { type: "create", path: "README.md", content: "fetched without a bridge\n" },
            { type: "create", path: "index.js", content: "const ready = true;\n" },
          ],
        }),
        token,
      );
      const greenStatus = await waitFor(
        "host-mounted health checkout returns GREEN",
        async () => {
          const { rows } = await db!.pool.query<{ status: string }>(
            "SELECT status FROM health_runs WHERE room_id = $1 AND revision = 1 ORDER BY created_at DESC LIMIT 1",
            [roomId],
          );
          return rows[0]?.status ?? null;
        },
        (status) => status === "GREEN",
      );
      expect(greenStatus).toBe("GREEN");
      await requestJson(
        `/v1/rooms/${roomId}/commands`,
        envelope("sandbox.exec", { command: "cat README.md", timeout_s: FIRST_EXEC_TIMEOUT_S }),
        token,
        200,
        FIRST_EXEC_BUDGET_MS,
      );

      const inspection = JSON.parse(
        await docker(["container", "inspect", "--format", "{{json .}}", containerName]),
      ) as {
        NetworkSettings: { Networks: Record<string, unknown>; Ports: Record<string, unknown> };
      };
      expect(Object.keys(inspection.NetworkSettings.Networks)).toEqual(
        expect.arrayContaining(["bridge", GIT_NETWORK]),
      );
      expect(inspection.NetworkSettings.Ports["8081/tcp"]).toBeFalsy();

      const content = await waitFor(
        "sandbox materialization of the canonical README",
        async () => {
          const id = await docker([
            "container",
            "ls",
            "--all",
            "--quiet",
            "--filter",
            "label=crossover.sandbox=true",
            "--filter",
            `label=crossover.room=${roomId}`,
          ]);
          if (!id) return "";
          return docker([
            "container",
            "exec",
            id.split(/\r?\n/)[0]!,
            "cat",
            "/workspace/README.md",
          ]);
        },
        (value) => value === "fetched without a bridge",
      );
      expect(content).toBe("fetched without a bridge");

      await requestJson(
        `/v1/rooms/${roomId}/commands`,
        envelope("workspace.apply_changeset", {
          source: "API",
          message: "Break index.js to verify host-mounted health checkout contents",
          base_workspace_revision: 1,
          operations: [{ type: "modify", path: "index.js", content: "const broken = ;\n" }],
        }),
        token,
      );
      const redStatus = await waitFor(
        "host-mounted health checkout returns RED for broken JavaScript",
        async () => {
          const { rows } = await db!.pool.query<{ status: string }>(
            "SELECT status FROM health_runs WHERE room_id = $1 AND revision = 2 ORDER BY created_at DESC LIMIT 1",
            [roomId],
          );
          return rows[0]?.status ?? null;
        },
        (status) => status === "RED",
      );
      expect(redStatus).toBe("RED");
    },
    HEALTH_TOPOLOGY_TIMEOUT_MS,
  );
});
