import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import {
  readConnectedIntegrationSecretConfig,
  registerIntegrationCommands,
  type IntegrationCommandsOptions,
  type GitHubPendingConnection,
  type GitHubPendingConnectionStore,
} from "./integrations.js";
import { ensureRoomDataKey } from "./room-key.js";
import type { EncryptedSecret, SecretStore } from "./secret-store.js";

let db: TestDatabase;
let pool: Pool;
let serial = 0;
const secretValues = new Map<string, string>();

const testSecretStore: SecretStore = {
  async seal(roomId, provider, plaintext, wrappedDataKey) {
    const id = `secret-${roomId}-${provider}-${++serial}`;
    secretValues.set(id, plaintext);
    return {
      version: 1,
      iv: Buffer.alloc(12, 1).toString("base64url"),
      ciphertext: Buffer.from(id).toString("base64url"),
      tag: Buffer.alloc(16, 2).toString("base64url"),
      wrapped_data_key: wrappedDataKey ?? null,
    } satisfies EncryptedSecret;
  },
  async open(_roomId, _provider, encrypted) {
    const id = Buffer.from(encrypted.ciphertext, "base64url").toString("utf8");
    const plaintext = secretValues.get(id);
    if (plaintext === undefined) throw new Error("test secret missing");
    return plaintext;
  },
};

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  await db.drop();
});

function envelope(method: string, params: Record<string, unknown> = {}) {
  return {
    id: newId("cmd"),
    method,
    params,
    idempotency_key: `integration-${++serial}`,
  };
}

async function participant(
  roomId: string,
  authority: Principal["authority"],
  kind: Principal["kind"],
  role: Principal["role"],
): Promise<Principal> {
  const participantId = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, $3, $1, $4, $5, 'ACTIVE')`,
    [participantId, roomId, kind, authority, role],
  );
  return { participant_id: participantId, room_id: roomId, authority, kind, role };
}

async function setup(
  secretStore: SecretStore = testSecretStore,
  options: Partial<IntegrationCommandsOptions> = {},
) {
  const roomId = newId("room");
  const ownerId = newId("part");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id)
     VALUES ($1, $2, 'Integrations', 'Protect credentials', $3)`,
    [roomId, `integrations-${++serial}`, ownerId],
  );
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, 'HUMAN', 'owner', 'OWNER', 'DEVELOPER', 'ACTIVE')`,
    [ownerId, roomId],
  );
  const owner: Principal = {
    participant_id: ownerId,
    room_id: roomId,
    kind: "HUMAN",
    authority: "OWNER",
    role: "DEVELOPER",
  };
  const admin = await participant(roomId, "ADMIN", "HUMAN", "DEVELOPER");
  const member = await participant(roomId, "MEMBER", "AGENT", "DEVELOPER");
  const lead = await participant(roomId, "MEMBER", "AGENT", "LEAD");
  const dispatcher = new Dispatcher({ pool, authorize, nodeId: `integrations-${++serial}` });
  registerIntegrationCommands(dispatcher, { ...options, secretStore });
  return { roomId, owner, admin, member, lead, dispatcher };
}

function pendingConnectionStore(initial?: GitHubPendingConnection) {
  let value = initial;
  let available = true;
  const matches = (pendingId: string, binding: { room_id: string; owner_participant_id: string }) =>
    value !== undefined &&
    pendingId === "p".repeat(43) &&
    binding.room_id === value.room_id &&
    binding.owner_participant_id === value.owner_participant_id;
  const store: GitHubPendingConnectionStore = {
    save: vi.fn(async () => {}),
    peek: vi.fn(async (pendingId, binding) =>
      available && matches(pendingId, binding) ? value : undefined,
    ),
    consume: vi.fn(async (pendingId, binding) => {
      if (!available || !matches(pendingId, binding)) return undefined;
      available = false;
      return value;
    }),
  };
  return { store, set: (next: GitHubPendingConnection) => (value = next) };
}

const dispatch = (
  fixture: Awaited<ReturnType<typeof setup>>,
  principal: Principal,
  method: string,
  params: Record<string, unknown> = {},
) => fixture.dispatcher.dispatch(principal, envelope(method, params));

describe("room integration commands", () => {
  it("encrypts OAuth credentials and keeps them out of responses, events and idempotency records", async () => {
    const f = await setup();
    const accessToken = "oauth-access-secret-value";
    const request = envelope("integrations.connect", {
      provider: "oauth:slack",
      access_token: accessToken,
    });
    const result = await f.dispatcher.dispatch(f.owner, request);

    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(result.response).toMatchObject({
      provider: "oauth:slack",
      status: "CONNECTED",
      config: {},
    });
    const integration = (
      await pool.query(
        "SELECT encrypted_secret FROM integrations WHERE room_id = $1 AND provider = 'oauth:slack'",
        [f.roomId],
      )
    ).rows[0];
    expect(JSON.stringify(integration.encrypted_secret)).not.toContain(accessToken);
    expect(
      await f.dispatcher
        .dispatch(f.owner, envelope("integrations.list"))
        .then((listed) => JSON.stringify(listed)),
    ).not.toContain(accessToken);
    const events = (
      await pool.query("SELECT payload FROM events WHERE room_id = $1 ORDER BY sequence", [
        f.roomId,
      ])
    ).rows;
    expect(events).toEqual([{ payload: { provider: "oauth:slack" } }]);
    const stored = (
      await pool.query(
        `SELECT response FROM idempotency_keys
         WHERE participant_id = $1 AND idempotency_key = $2`,
        [f.owner.participant_id, request.idempotency_key],
      )
    ).rows[0].response;
    expect(JSON.stringify(stored)).not.toContain(accessToken);
  });

  it("rejects the removed GitHub code contract without persisting it", async () => {
    const f = await setup();
    const authorizationCode = "github-authorization-code-secret";
    const withCode = await dispatch(f, f.owner, "integrations.connect", {
      provider: "github",
      pending_id: "p".repeat(43),
      code: authorizationCode,
      repositories: ["Example/Service"],
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(withCode).toMatchObject({ code: "VALIDATION" });
    expect(JSON.stringify(withCode)).not.toContain(authorizationCode);
    const stored = await pool.query("SELECT 1 FROM integrations WHERE room_id = $1", [f.roomId]);
    expect(stored.rowCount).toBe(0);
    const key = await pool.query("SELECT 1 FROM integration_room_keys WHERE room_id = $1", [
      f.roomId,
    ]);
    expect(key.rowCount).toBe(0);
  });

  it("stores only the selected repository from the owner and room-bound pending record", async () => {
    const pending = pendingConnectionStore();
    const connectedFixture = await setup(testSecretStore, {
      githubPendingConnections: pending.store,
    });
    pending.set({
      room_id: connectedFixture.roomId,
      owner_participant_id: connectedFixture.owner.participant_id,
      installation_id: "123456",
      repositories: [{ name: "Example/Service", id: "8910" }],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const result = await dispatch(
      connectedFixture,
      connectedFixture.owner,
      "integrations.connect",
      {
        provider: "github",
        pending_id: "p".repeat(43),
        repositories: ["Example/Service"],
      },
    );

    expect(pending.store.peek).toHaveBeenCalledWith("p".repeat(43), {
      room_id: connectedFixture.roomId,
      owner_participant_id: connectedFixture.owner.participant_id,
    });
    expect(pending.store.consume).toHaveBeenCalledWith("p".repeat(43), {
      room_id: connectedFixture.roomId,
      owner_participant_id: connectedFixture.owner.participant_id,
    });
    expect(JSON.stringify(result)).not.toContain("p".repeat(43));
    expect(result.response).toMatchObject({
      provider: "github",
      status: "CONNECTED",
      config: { installation_id: "123456", repositories: ["example/service"] },
    });
    const encrypted = (
      await pool.query("SELECT encrypted_secret FROM integrations WHERE room_id = $1", [
        connectedFixture.roomId,
      ])
    ).rows[0].encrypted_secret;
    expect(
      secretValues.get(Buffer.from(encrypted.ciphertext, "base64url").toString("utf8")),
    ).toEqual(
      JSON.stringify({
        installation_id: "123456",
        repositories_json: '["example/service"]',
        repository_ids_json: '["8910"]',
      }),
    );
    const replay = await dispatch(
      connectedFixture,
      connectedFixture.owner,
      "integrations.connect",
      {
        provider: "github",
        pending_id: "p".repeat(43),
        repositories: ["Example/Service"],
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(replay).toMatchObject({ code: "VALIDATION" });
  });

  it("does not consume a GitHub pending record for a repository outside the verified list", async () => {
    const pending = pendingConnectionStore();
    const g = await setup(testSecretStore, { githubPendingConnections: pending.store });
    pending.set({
      room_id: g.roomId,
      owner_participant_id: g.owner.participant_id,
      installation_id: "123456",
      repositories: [{ name: "Example/Service", id: "8910" }],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const error = await dispatch(g, g.owner, "integrations.connect", {
      provider: "github",
      pending_id: "p".repeat(43),
      repositories: ["Example/Unverified"],
    }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({ code: "VALIDATION" });
    expect(pending.store.consume).not.toHaveBeenCalled();
  });

  it("retries a pending AWS role verification without returning its external ID", async () => {
    let connected = false;
    const verifier = vi.fn(async () => ({ connected }));
    const f = await setup(testSecretStore, { verifyAwsRole: verifier });
    const initial = await dispatch(f, f.owner, "integrations.connect", {
      provider: "aws",
      role_arn: "arn:aws:iam::123456789012:role/CrossoverDeploy",
    });
    expect(initial.response).toMatchObject({
      status: "PENDING",
      status_reason: "assume_role_failed",
    });
    connected = true;
    const verified = await dispatch(f, f.owner, "integrations.verify", { provider: "aws" });
    expect(verified.response).toEqual({
      provider: "aws",
      status: "CONNECTED",
      status_reason: null,
    });
    expect(JSON.stringify(verified)).not.toContain(
      (initial.one_time as { external_id: string }).external_id,
    );
    await expect(
      readConnectedIntegrationSecretConfig(pool, testSecretStore, f.roomId, "aws"),
    ).resolves.toMatchObject({
      configuration: { role_arn: "arn:aws:iam::123456789012:role/CrossoverDeploy" },
    });
  });

  it("returns AWS external IDs once, keeps them encrypted, and lets only the owner connect or disconnect", async () => {
    const f = await setup();
    const request = envelope("integrations.connect", {
      provider: "aws",
      role_arn: "arn:aws:iam::123456789012:role/CrossoverDeploy",
    });
    const result = await f.dispatcher.dispatch(f.owner, request);
    const externalId = (result.one_time as { external_id: string }).external_id;
    expect(externalId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(result.response)).not.toContain(externalId);
    expect(result.events.map((event) => event.payload)).toEqual([{ provider: "aws" }]);
    const secret = (
      await pool.query("SELECT encrypted_secret FROM integrations WHERE room_id = $1", [f.roomId])
    ).rows[0].encrypted_secret;
    expect(JSON.stringify(secret)).not.toContain(externalId);

    const ownerList = await dispatch(f, f.owner, "integrations.list");
    const adminList = await dispatch(f, f.admin, "integrations.list");
    const memberList = await dispatch(f, f.member, "integrations.list");
    expect(ownerList.response).toMatchObject({
      integrations: [
        { provider: "aws", config: { role_arn: "arn:aws:iam::123456789012:role/CrossoverDeploy" } },
      ],
    });
    expect(adminList.response).toMatchObject({
      integrations: [{ config: { role_arn: expect.any(String) } }],
    });
    expect(memberList.response).toMatchObject({ integrations: [{ provider: "aws" }] });
    expect(
      (memberList.response as { integrations: Array<Record<string, unknown>> }).integrations[0],
    ).not.toHaveProperty("config");

    await expect(
      dispatch(f, f.admin, "integrations.disconnect", { provider: "aws" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: { missing_capability: "integrations.manage" },
    });
    await expect(
      dispatch(f, f.lead, "integrations.connect", {
        provider: "oauth:slack",
        access_token: "forbidden-token-value",
      }),
    ).rejects.toBeInstanceOf(CrossoverError);
    const disconnected = await dispatch(f, f.owner, "integrations.disconnect", { provider: "aws" });
    expect(disconnected.response).toEqual({ provider: "aws", disconnected: true });
    expect(disconnected.events.map((event) => event.payload)).toEqual([{ provider: "aws" }]);
    expect(
      (
        await pool.query("SELECT count(*)::int AS count FROM integrations WHERE room_id = $1", [
          f.roomId,
        ])
      ).rows[0].count,
    ).toBe(0);
  });

  it("does not place a secret-bearing connect request into the approvals table", async () => {
    const f = await setup();
    const token = "approval-queue-secret-token";
    await pool.query(
      `INSERT INTO capability_grants
         (id, room_id, participant_id, effect, capability, requires_approval, created_by)
       VALUES ($1, $2, $3, 'GRANT', 'integrations.manage', true, $4)`,
      [newId("grant"), f.roomId, f.owner.participant_id, f.owner.participant_id],
    );

    const error = await dispatch(f, f.owner, "integrations.connect", {
      provider: "oauth:slack",
      access_token: token,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toMatchObject({
      code: "VALIDATION",
      details: { reason: "not_approvable", method: "integrations.connect" },
    });
    const approvals = await pool.query("SELECT params FROM approvals WHERE room_id = $1", [
      f.roomId,
    ]);
    expect(approvals.rows).toEqual([]);
    expect(JSON.stringify(approvals.rows)).not.toContain(token);
  });

  it("races two first room-key writes without surfacing a unique-constraint error", async () => {
    const f = await setup();
    const encrypted = (wrappedDataKey: string): EncryptedSecret => ({
      version: 1,
      iv: Buffer.alloc(12, 1).toString("base64url"),
      ciphertext: "AA",
      tag: Buffer.alloc(16, 2).toString("base64url"),
      wrapped_data_key: wrappedDataKey,
    });
    const ensure = async (wrappedDataKey: string) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await ensureRoomDataKey(client, f.roomId, encrypted(wrappedDataKey));
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };

    const outcomes = await Promise.allSettled([
      ensure("kms-wrapped-first"),
      ensure("kms-wrapped-second"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const conflict = outcomes.find((outcome) => outcome.status === "rejected");
    expect(conflict?.status).toBe("rejected");
    if (conflict?.status === "rejected") {
      expect(conflict.reason).toMatchObject({ code: "CONFLICT_VERSION", retryable: true });
    }
  });

  it("handles concurrent first connects with a retryable key mismatch", async () => {
    let resolveSeals!: () => void;
    const bothSealed = new Promise<void>((resolve) => {
      resolveSeals = resolve;
    });
    let seals = 0;
    const racingSecretStore: SecretStore = {
      async seal(roomId, provider, plaintext, wrappedDataKey) {
        const ordinal = ++seals;
        const id = `race-secret-${roomId}-${provider}-${serial++}`;
        secretValues.set(id, plaintext);
        if (ordinal === 2) resolveSeals();
        await bothSealed;
        return {
          version: 1,
          iv: Buffer.alloc(12, 3).toString("base64url"),
          ciphertext: Buffer.from(id).toString("base64url"),
          tag: Buffer.alloc(16, 4).toString("base64url"),
          wrapped_data_key: wrappedDataKey ?? `kms-wrapped-${ordinal}`,
        };
      },
      open: testSecretStore.open,
    };
    const f = await setup(racingSecretStore);
    const outcomes = await Promise.allSettled([
      dispatch(f, f.owner, "integrations.connect", {
        provider: "aws",
        role_arn: "arn:aws:iam::123456789012:role/CrossoverDeploy",
      }),
      dispatch(f, f.owner, "integrations.connect", {
        provider: "oauth:slack",
        access_token: "concurrent-token-value",
      }),
    ]);

    expect(seals).toBe(2);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const conflict = outcomes.find((outcome) => outcome.status === "rejected");
    expect(conflict?.status).toBe("rejected");
    if (conflict?.status === "rejected") {
      expect(conflict.reason).toMatchObject({
        code: "CONFLICT_VERSION",
        retryable: true,
        details: { reason: "integration_key_changed" },
      });
    }
    const stored = await pool.query("SELECT provider FROM integrations WHERE room_id = $1", [
      f.roomId,
    ]);
    expect(stored.rowCount).toBe(1);
  });

  it("releases secrets only for CONNECTED, unexpired integrations", async () => {
    const secretStore: SecretStore = {
      ...testSecretStore,
      open: vi.fn(testSecretStore.open),
    };
    const f = await setup(secretStore);
    await dispatch(f, f.owner, "integrations.connect", {
      provider: "aws",
      role_arn: "arn:aws:iam::123456789012:role/CrossoverDeploy",
    });

    await expect(
      readConnectedIntegrationSecretConfig(pool, secretStore, f.roomId, "aws"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(secretStore.open).not.toHaveBeenCalled();

    await dispatch(f, f.owner, "integrations.connect", {
      provider: "oauth:slack",
      access_token: "connected-token-value",
      expires_at: "2999-01-01T00:00:00Z",
    });
    await expect(
      readConnectedIntegrationSecretConfig(pool, secretStore, f.roomId, "oauth:slack"),
    ).resolves.toMatchObject({
      configuration: {
        access_token: "connected-token-value",
        expires_at: "2999-01-01T00:00:00Z",
      },
    });

    await dispatch(f, f.owner, "integrations.connect", {
      provider: "oauth:slack",
      access_token: "expired-token-value",
      expires_at: "2020-01-01T00:00:00Z",
    });
    await expect(
      readConnectedIntegrationSecretConfig(pool, secretStore, f.roomId, "oauth:slack"),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(
      pool.query(
        "SELECT status, status_reason FROM integrations WHERE room_id = $1 AND provider = 'oauth:slack'",
        [f.roomId],
      ),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ status: "EXPIRED", status_reason: "token_expired" })],
    });
  });

  it("marks expired OAuth tokens", async () => {
    const f = await setup();
    const expired = await dispatch(f, f.owner, "integrations.connect", {
      provider: "oauth:slack",
      access_token: "already-expired-token-value",
      expires_at: "2020-01-01T00:00:00Z",
    });
    expect(expired.response).toMatchObject({ status: "EXPIRED", status_reason: "token_expired" });
  });
});
