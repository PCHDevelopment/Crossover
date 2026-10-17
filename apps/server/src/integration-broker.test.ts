import { generateKeyPairSync } from "node:crypto";
import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import {
  Dispatcher,
  registerIntegrationCommands,
  registerToolCommands,
  ToolRegistry,
  type ToolExecutionSpec,
  type ToolInvocation,
  type ToolRunner,
} from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConfigKeyRoomDataKeyProvider, EnvelopeSecretStore } from "./secret-store.js";
import { IntegrationCredentialBroker, type AssumeRoleInput } from "./integration-broker.js";

const invocation: ToolInvocation = {
  tool: "github.read_repository",
  args: { repo: "example/repo" },
  capability: "github.read_repository:example/repo",
  scope: "example/repo",
  room_id: "room_fixture",
  participant_id: "participant_fixture",
  invocation_id: "cmd_fixture",
};

const app = {
  appId: "12345",
  slug: "crossover-github",
  clientId: "client-fixture",
  clientSecret: "client-secret-fixture",
  privateKey: String(
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    }),
  ),
};

const restoreLogCaptures: Array<() => void> = [];
afterEach(() => {
  for (const restore of restoreLogCaptures.splice(0)) restore();
});

function captureRuntimeLogs(): string[] {
  const entries: string[] = [];
  const consoleDescriptors = new Map<string, PropertyDescriptor>();
  for (const name of Object.getOwnPropertyNames(console)) {
    const descriptor = Object.getOwnPropertyDescriptor(console, name);
    if (
      !descriptor ||
      typeof descriptor.value !== "function" ||
      name.startsWith("_") ||
      name === "Console"
    )
      continue;
    consoleDescriptors.set(name, descriptor);
    Object.defineProperty(console, name, {
      ...descriptor,
      value: (...args: unknown[]) => entries.push(args.map(stringifyLogValue).join(" ")),
    });
  }

  const emitWarningDescriptor = Object.getOwnPropertyDescriptor(process, "emitWarning");
  if (!emitWarningDescriptor || typeof emitWarningDescriptor.value !== "function")
    throw new Error("process.emitWarning is not available");
  Object.defineProperty(process, "emitWarning", {
    ...emitWarningDescriptor,
    value: (...args: unknown[]) => entries.push(args.map(stringifyLogValue).join(" ")),
  });

  restoreLogCaptures.push(() => {
    for (const [name, descriptor] of consoleDescriptors)
      Object.defineProperty(console, name, descriptor);
    Object.defineProperty(process, "emitWarning", emitWarningDescriptor);
  });
  return entries;
}

function stringifyLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db?.drop();
});

function broker(options: {
  secret: Record<string, string>;
  publicConfig?: Record<string, unknown>;
  fetcher?: typeof fetch;
  assumeRole?: (input: AssumeRoleInput) => Promise<{
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  }>;
}) {
  const pool = {
    query: vi.fn(async () => ({
      rows: [
        {
          status: "CONNECTED",
          encrypted_secret: { version: 1, iv: "", ciphertext: "", tag: "", wrapped_data_key: null },
          public_config: options.publicConfig ?? {},
        },
      ],
    })),
  } as unknown as Pool;
  return new IntegrationCredentialBroker({
    pool,
    secretStore: { seal: vi.fn(), open: vi.fn(async () => JSON.stringify(options.secret)) },
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.assumeRole ? { assumeRole: options.assumeRole } : {}),
    github: app,
  });
}

describe("IntegrationCredentialBroker", () => {
  it("verifies a GitHub App installation without minting an installation token", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/app/installations/41"))
        return Response.json({ id: 41, suspended_at: null });
      if (url.endsWith("/app/installations/42"))
        return Response.json({ id: 42, suspended_at: "2026-10-01T00:00:00Z" });
      throw new Error("Unexpected GitHub request");
    };
    const service = broker({ secret: {}, fetcher });

    await expect(service.verifyGitHubInstallation({ installation_id: "41" })).resolves.toEqual({
      connected: true,
    });
    await expect(service.verifyGitHubInstallation({ installation_id: "42" })).resolves.toEqual({
      connected: false,
    });
    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.github.com/app/installations/41",
      "https://api.github.com/app/installations/42",
    ]);
    expect(requests.every(({ init }) => init?.headers !== undefined)).toBe(true);
    expect(requests.every(({ url }) => !url.includes("access_tokens"))).toBe(true);
  });

  it("exchanges, verifies and revokes the GitHub OAuth token without retaining the code", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url === "https://github.com/login/oauth/access_token")
        return Response.json({ access_token: "github-user-token" });
      if (url.endsWith("/user/installations?per_page=100&page=1"))
        return Response.json({ installations: [{ id: 41 }] });
      if (url.endsWith("/user/installations/41/repositories?per_page=100&page=1"))
        return Response.json({ repositories: [{ id: 9823, full_name: "Example/Repo" }] });
      if (url.endsWith("/applications/client-fixture/token"))
        return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${url}`);
    };
    const service = broker({ secret: {}, fetcher });
    const connected = await service.authorizeGitHubInstallation({
      installation_id: 41,
      code: "one-time-code",
    });

    expect(connected).toEqual([{ name: "Example/Repo", id: "9823" }]);
    expect(requests[0]?.init?.body).toContain("one-time-code");
    expect(requests.at(-1)?.init?.body).toContain("github-user-token");
    expect(requests.some(({ init }) => JSON.stringify(init).includes("one-time-code"))).toBe(true);
  });

  it("revokes the GitHub user token when the selected installation is not user-authorized", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url === "https://github.com/login/oauth/access_token")
        return Response.json({ access_token: "temporary-user-token" });
      if (url.endsWith("/user/installations?per_page=100&page=1"))
        return Response.json({ installations: [{ id: 99 }] });
      if (url.endsWith("/applications/client-fixture/token"))
        return new Response(null, { status: 204 });
      throw new Error("Unexpected GitHub request");
    };
    const service = broker({ secret: {}, fetcher });

    await expect(
      service.authorizeGitHubInstallation({ installation_id: 41, code: "one-time-code" }),
    ).rejects.toThrow("Installation is not controlled by the authorizing user");
    expect(requests.some(({ url }) => url.includes("/repositories?"))).toBe(false);
    expect(requests.at(-1)?.init?.body).toContain("temporary-user-token");
  });

  it("mints a GitHub token for only the scoped repository and revokes it once", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/app/installations/41/access_tokens"))
        return Response.json({
          token: "github-install-token",
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        });
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${url}`);
    };
    const service = broker({
      secret: {
        installation_id: "41",
        repositories_json: '["example/repo","example/other"]',
        repository_ids_json: '["9823","9824"]',
      },
      fetcher,
    });
    const declaredPermissions = { contents: "read", pull_requests: "write" } as const;
    const execution: ToolExecutionSpec = {
      image: "fixture",
      command: ["run"],
      egressHosts: [],
      integrations: [{ provider: "github", permissions: declaredPermissions }],
    };
    const lease = await service.credentialsFor(invocation, execution);

    expect(lease.environment).toEqual({ GITHUB_TOKEN: "github-install-token" });
    const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ repository_ids: [9823], permissions: declaredPermissions });
    await lease.revoke?.();
    expect(requests.filter(({ url }) => url.endsWith("/installation/token"))).toHaveLength(1);
  });

  it("mints the export lease for the selected repository with only the requested permissions", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/app/installations/41/access_tokens"))
        return Response.json({ token: "github-export-token" });
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error("Unexpected request");
    };
    const service = broker({
      secret: {
        installation_id: "41",
        repositories_json: '["example/repo","example/other"]',
        repository_ids_json: '["9823","9824"]',
      },
      fetcher,
    });
    const lease = await service.githubCredentialForRoom({
      room_id: invocation.room_id,
      invocation_id: "cmd_export",
      repository: "example/repo",
      access: "write",
      permissions: { contents: "write", pull_requests: "write" },
    });

    expect(lease?.credential).toEqual({ type: "bearer", token: "github-export-token" });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      repository_ids: [9823],
      permissions: { contents: "write", pull_requests: "write" },
    });
    await lease?.revoke();
    expect(requests.filter(({ url }) => url.endsWith("/installation/token"))).toHaveLength(1);
  });

  it("mints 15-minute AWS credentials with the invocation id in its session name", async () => {
    const assumeRole = vi.fn(async () => ({
      accessKeyId: "short-access-key",
      secretAccessKey: "short-secret-key",
      sessionToken: "short-session-token",
    }));
    const service = broker({
      secret: { external_id: "room-external-id" },
      publicConfig: { role_arn: "arn:aws:iam::123456789012:role/Room" },
      assumeRole,
    });
    const execution: ToolExecutionSpec = {
      image: "fixture",
      command: ["run"],
      egressHosts: [],
      integrations: [{ provider: "aws" }],
    };

    const lease = await service.credentialsFor(invocation, execution);
    expect(lease.environment).toEqual({
      AWS_ACCESS_KEY_ID: "short-access-key",
      AWS_SECRET_ACCESS_KEY: "short-secret-key",
      AWS_SESSION_TOKEN: "short-session-token",
    });
    expect(assumeRole).toHaveBeenCalledWith({
      room_id: invocation.room_id,
      role_arn: "arn:aws:iam::123456789012:role/Room",
      external_id: "room-external-id",
      invocation_id: invocation.invocation_id,
    });
  });

  it("keeps connection and minted secrets out of responses, events, logs and tool records", async () => {
    const runtimeLogs = captureRuntimeLogs();
    const roomId = newId("room");
    const ownerId = newId("part");
    const agentId = newId("part");
    await db.pool.query(
      "INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $2, 'Broker', 'Protect credentials', $3)",
      [roomId, "broker-" + newId("cmd").replaceAll("_", "-"), ownerId],
    );
    await db.pool.query(
      "INSERT INTO participants (id, room_id, kind, display_name, authority, role, status) VALUES ($1, $3, 'HUMAN', 'owner', 'OWNER', 'DEVELOPER', 'ACTIVE'), ($2, $3, 'AGENT', 'agent', 'MEMBER', 'DEVELOPER', 'ACTIVE')",
      [ownerId, agentId, roomId],
    );
    const owner = {
      room_id: roomId,
      participant_id: ownerId,
      kind: "HUMAN" as const,
      authority: "OWNER" as const,
      role: "DEVELOPER" as const,
    };
    const agent = {
      room_id: roomId,
      participant_id: agentId,
      kind: "AGENT" as const,
      authority: "MEMBER" as const,
      role: "DEVELOPER" as const,
    };
    const secretStore = new EnvelopeSecretStore(
      new ConfigKeyRoomDataKeyProvider(Buffer.alloc(32, 7)),
    );
    const userToken = "github-user-access-token-secret";
    const githubToken = "github-installation-token-secret";
    const oauthToken = "oauth-slack-access-token-secret";
    let revokeCount = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token")
        return Response.json({ access_token: userToken });
      if (url.endsWith("/user/installations?per_page=100&page=1"))
        return Response.json({ installations: [{ id: 41 }] });
      if (url.endsWith("/user/installations/41/repositories?per_page=100&page=1"))
        return Response.json({ repositories: [{ id: 9823, full_name: "acme/widgets" }] });
      if (url.endsWith("/applications/client-fixture/token"))
        return new Response(null, { status: 204 });
      if (url.endsWith("/app/installations/41/access_tokens"))
        return Response.json({
          token: githubToken,
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        });
      if (url.endsWith("/installation/token")) {
        revokeCount += 1;
        if (revokeCount === 2) throw new Error(`revocation failed for ${githubToken}`);
        return new Response(null, { status: 204 });
      }
      throw new Error("Unexpected GitHub request");
    };
    const service = new IntegrationCredentialBroker({
      pool: db.pool,
      secretStore,
      github: app,
      fetcher,
    });
    const registry = new ToolRegistry({
      tierOf: (capability) => (capability === "github.create_pull_request" ? 2 : 0),
    });
    registry.register({
      name: "github.create_pull_request",
      description: "Create a pull request",
      capability: "github.create_pull_request",
      tier: 2,
      input: z.strictObject({ repo: z.string(), title: z.string() }),
      scope: (args) => args.repo,
      normalizeScope: (scope) => scope.toLowerCase(),
      idempotent: false,
      execution: {
        image: "busybox:1.36.1-musl@sha256:" + "a".repeat(64),
        command: ["node", "worker.js"],
        egressHosts: [],
        integrations: [
          { provider: "github", permissions: { pull_requests: "write" } },
          { provider: "oauth:slack" },
        ],
      },
    });
    const environments: Record<string, string>[] = [];
    const runner: ToolRunner = {
      async run(runInvocation) {
        const execution = registry.get(runInvocation.tool)!.execution!;
        const lease = await service.credentialsFor(runInvocation, execution);
        try {
          environments.push({ ...lease.environment });
          return { result: { ok: true } };
        } finally {
          await lease.revoke?.();
        }
      },
    };
    const dispatcher = new Dispatcher({
      pool: db.pool,
      authorize,
      nodeId: "broker-" + newId("cmd"),
    });
    const pendingId = "p".repeat(43);
    const pendingValue = {
      room_id: roomId,
      owner_participant_id: ownerId,
      installation_id: "41",
      repositories: [{ name: "acme/widgets", id: "9823" }],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    let pendingAvailable = true;
    const matchesPending = (
      id: string,
      binding: { room_id: string; owner_participant_id: string },
    ) => id === pendingId && binding.room_id === roomId && binding.owner_participant_id === ownerId;
    registerIntegrationCommands(dispatcher, {
      secretStore,
      githubPendingConnections: {
        async save() {},
        async peek(id, binding) {
          return pendingAvailable && matchesPending(id, binding) ? pendingValue : undefined;
        },
        async consume(id, binding) {
          if (!pendingAvailable || !matchesPending(id, binding)) return undefined;
          pendingAvailable = false;
          return pendingValue;
        },
      },
    });
    registerToolCommands(dispatcher, { registry, runner });
    await db.pool.query(
      "INSERT INTO capability_grants (id, room_id, participant_id, effect, capability, requires_approval, created_by) VALUES ($1, $2, $3, 'GRANT', 'github.create_pull_request:acme/widgets', false, $4)",
      [newId("grant"), roomId, agentId, ownerId],
    );
    const envelope = (method: string, params: Record<string, unknown>) => ({
      id: newId("cmd"),
      method,
      params,
      idempotency_key: "broker-" + newId("cmd"),
    });
    const githubConnect = await dispatcher.dispatch(
      owner,
      envelope("integrations.connect", {
        provider: "github",
        pending_id: pendingId,
        repositories: ["acme/widgets"],
      }),
    );
    const oauthConnect = await dispatcher.dispatch(
      owner,
      envelope("integrations.connect", { provider: "oauth:slack", access_token: oauthToken }),
    );
    const toolResponse = await dispatcher.dispatch(
      agent,
      envelope("tools.invoke", {
        tool: "github.create_pull_request",
        args: { repo: "acme/widgets", title: "Safe" },
      }),
    );
    const failedToolResponse = await dispatcher
      .dispatch(
        agent,
        envelope("tools.invoke", {
          tool: "github.create_pull_request",
          args: { repo: "acme/widgets", title: "Exercise failed revocation" },
        }),
      )
      .catch((error: unknown) => {
        if (!(error instanceof Error)) throw error;
        return { name: error.name, message: error.message };
      });
    const events = (
      await db.pool.query("SELECT type, payload FROM events WHERE room_id = $1 ORDER BY sequence", [
        roomId,
      ])
    ).rows;
    const toolRows = (
      await db.pool.query("SELECT outcome FROM tool_invocations WHERE room_id = $1", [roomId])
    ).rows;
    const commandRows = (
      await db.pool.query("SELECT response FROM idempotency_keys WHERE participant_id = ANY($1)", [
        [ownerId, agentId],
      ])
    ).rows;
    const approvalRows = (
      await db.pool.query("SELECT params FROM approvals WHERE room_id = $1", [roomId])
    ).rows;
    const encryptedRows = (
      await db.pool.query("SELECT encrypted_secret FROM integrations WHERE room_id = $1", [roomId])
    ).rows;
    const persisted = JSON.stringify({
      responses: [githubConnect, oauthConnect, toolResponse, failedToolResponse],
      events,
      toolRows,
      commandRows,
      approvalRows,
      encryptedRows,
    });
    const logs = runtimeLogs.join("\n");

    expect(environments).toEqual([
      { GITHUB_TOKEN: githubToken, OAUTH_SLACK_TOKEN: oauthToken },
      { GITHUB_TOKEN: githubToken, OAUTH_SLACK_TOKEN: oauthToken },
    ]);
    expect(JSON.stringify(toolResponse)).not.toContain(githubToken);
    expect(JSON.stringify(toolResponse)).not.toContain(oauthToken);
    expect(failedToolResponse).toMatchObject({ message: "github.create_pull_request failed" });
    expect(JSON.stringify(failedToolResponse)).not.toContain(githubToken);
    for (const secret of [userToken, githubToken, oauthToken])
      expect(persisted).not.toContain(secret);
    for (const secret of [userToken, githubToken, oauthToken]) expect(logs).not.toContain(secret);
    expect(revokeCount).toBe(2);
    expect(events.filter((event) => event.type === "tool.invoked")).toHaveLength(2);
    expect(events.filter((event) => event.type === "integration.connected")).toHaveLength(2);
  });
});
