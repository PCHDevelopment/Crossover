import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { Dispatcher, PrepareContext } from "../../dispatcher.js";
import type { EncryptedSecret, SecretStore } from "./secret-store.js";
import { ensureRoomDataKey } from "./room-key.js";

export type {
  GitHubPendingConnection,
  GitHubPendingConnectionStore,
  GitHubPendingRepository,
} from "./github-pending.js";

const PROVIDER_PATTERN = /^(?:github|aws|oauth:[a-z][a-z0-9_]{1,31})$/;
const ROLE_ARN_PATTERN =
  /^arn:(?:aws|aws-us-gov|aws-cn):iam::\d{12}:role\/[A-Za-z0-9+=,.@/_-]{1,512}$/;

const providerSchema = z.string().regex(PROVIDER_PATTERN);

export const integrationsConnectParams = z
  .strictObject({
    provider: providerSchema,
    role_arn: z.string().regex(ROLE_ARN_PATTERN).optional(),
    access_token: z.string().min(1).max(8192).optional(),
    expires_at: z.iso.datetime({ offset: true }).optional(),
    pending_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
    repositories: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/))
      .min(1)
      .max(100)
      .optional(),
  })
  .superRefine((params, ctx) => {
    const only = (allowed: readonly string[]) => {
      for (const field of [
        "role_arn",
        "access_token",
        "expires_at",
        "pending_id",
        "repositories",
      ] as const) {
        if (!allowed.includes(field) && params[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: "Not valid for this provider" });
        }
      }
    };
    if (params.provider === "github") {
      only(["pending_id", "repositories"]);
      for (const field of ["pending_id", "repositories"] as const) {
        if (params[field] === undefined)
          ctx.addIssue({ code: "custom", path: [field], message: "Required" });
      }
    } else if (params.provider === "aws") {
      only(["role_arn"]);
      if (!params.role_arn)
        ctx.addIssue({ code: "custom", path: ["role_arn"], message: "Required" });
    } else {
      only(["access_token", "expires_at"]);
      if (!params.access_token)
        ctx.addIssue({ code: "custom", path: ["access_token"], message: "Required" });
    }
  });

export const integrationsDisconnectParams = z.strictObject({ provider: providerSchema });
export const integrationsVerifyParams = z.strictObject({ provider: z.literal("aws") });
export const integrationsListParams = z.strictObject({});

export type IntegrationConnectionStatus = "PENDING" | "CONNECTED" | "EXPIRED";

export interface AwsRoleVerifier {
  (input: { room_id: string; role_arn: string; external_id: string }): Promise<{
    connected: boolean;
  }>;
}

export interface IntegrationCommandsOptions {
  /** Encrypts all provider secrets before the command opens its PostgreSQL transaction. */
  secretStore?: SecretStore;
  /** Implemented by the broker layer; failed role assumptions stay pending. */
  verifyAwsRole?: AwsRoleVerifier;
  /** Verified GitHub installation selections created by the server-side install callback. */
  githubPendingConnections?: GitHubPendingConnectionStore;
}

export async function readConnectedIntegrationSecretConfig(
  pool: Pool,
  secretStore: SecretStore,
  roomId: string,
  provider: string,
  requiredStatus: "CONNECTED" | "PENDING" = "CONNECTED",
): Promise<{ configuration: Readonly<Record<string, string>>; encrypted_secret: EncryptedSecret }> {
  const { rows } = await pool.query<{
    status: IntegrationConnectionStatus;
    encrypted_secret: EncryptedSecret;
    public_config: Record<string, unknown>;
  }>(
    `SELECT status, encrypted_secret, public_config FROM integrations
     WHERE room_id = $1 AND provider = $2`,
    [roomId, provider],
  );
  const row = rows[0];
  if (!row || row.status !== requiredStatus) {
    throw new CrossoverError("PROVIDER_UNAVAILABLE", "Integration credential is unavailable");
  }

  try {
    const config: unknown = JSON.parse(
      await secretStore.open(roomId, provider, row.encrypted_secret),
    );
    if (
      config === null ||
      typeof config !== "object" ||
      Array.isArray(config) ||
      Object.values(config).some((value) => typeof value !== "string")
    ) {
      throw new Error("Invalid integration secret config");
    }
    const values = config as Record<string, string>;
    const publicValues = Object.fromEntries(
      Object.entries(row.public_config).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    if (
      typeof values.expires_at === "string" &&
      new Date(values.expires_at).getTime() <= Date.now()
    ) {
      await pool.query(
        `UPDATE integrations SET status = 'EXPIRED', status_reason = 'token_expired',
           updated_at = clock_timestamp()
         WHERE room_id = $1 AND provider = $2 AND status = 'CONNECTED'
           AND encrypted_secret = $3::jsonb`,
        [roomId, provider, JSON.stringify(row.encrypted_secret)],
      );
      throw new Error("Integration credential expired");
    }
    return {
      configuration: Object.freeze({ ...publicValues, ...values }),
      encrypted_secret: row.encrypted_secret,
    };
  } catch {
    throw new CrossoverError("PROVIDER_UNAVAILABLE", "Integration credential is unavailable");
  }
}

interface IntegrationKeyRow {
  key_strategy: "CONFIG" | "KMS";
  wrapped_data_key: string | null;
}

interface PreparedConnection {
  provider: string;
  status: IntegrationConnectionStatus;
  status_reason: string | null;
  public_config: Record<string, unknown>;
  encrypted_secret: EncryptedSecret;
  connected_at: string | null;
  external_id?: string;
}

interface IntegrationRow {
  provider: string;
  status: IntegrationConnectionStatus;
  status_reason: string | null;
  public_config: Record<string, unknown>;
  connected_at: Date | string | null;
  connected_by: string;
}

/** Register owner-managed integration storage commands (§21.5, T1203). */
export function registerIntegrationCommands(
  dispatcher: Dispatcher,
  options: IntegrationCommandsOptions = {},
): void {
  dispatcher.registerCommand({
    method: "integrations.connect",
    action: "integrations.manage",
    mutating: true,
    returnsOneTime: true,
    notApprovable: true,
    params: integrationsConnectParams,
    prepare: async (ctx, params) => prepareConnection(ctx, params, options),
    execute: async (ctx, params) => {
      await requireOwner(ctx.client, ctx.room_id, ctx.principal.participant_id);
      const prepared = ctx.prepared as PreparedConnection | undefined;
      if (!prepared || prepared.provider !== params.provider) {
        throw new CrossoverError("PROVIDER_UNAVAILABLE", "Integration preparation failed");
      }
      await ensureRoomDataKey(ctx.client, ctx.room_id, prepared.encrypted_secret);
      await ctx.client.query(
        `INSERT INTO integrations
           (room_id, provider, status, status_reason, public_config, encrypted_secret,
            connected_at, connected_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)
         ON CONFLICT (room_id, provider) DO UPDATE SET
           status = EXCLUDED.status,
           status_reason = EXCLUDED.status_reason,
           public_config = EXCLUDED.public_config,
           encrypted_secret = EXCLUDED.encrypted_secret,
           connected_at = EXCLUDED.connected_at,
           connected_by = EXCLUDED.connected_by,
           updated_at = clock_timestamp()`,
        [
          ctx.room_id,
          prepared.provider,
          prepared.status,
          prepared.status_reason,
          JSON.stringify(prepared.public_config),
          JSON.stringify(prepared.encrypted_secret),
          prepared.connected_at,
          ctx.principal.participant_id,
        ],
      );
      return {
        response: {
          provider: prepared.provider,
          status: prepared.status,
          status_reason: prepared.status_reason,
          connected_at: prepared.connected_at,
          connected_by: ctx.principal.participant_id,
          config: prepared.public_config,
        },
        ...(prepared.external_id ? { oneTime: { external_id: prepared.external_id } } : {}),
        events: [
          {
            type: "integration.connected",
            payload: { provider: prepared.provider },
          },
        ],
      };
    },
  });

  dispatcher.registerCommand({
    method: "integrations.verify",
    action: "integrations.manage",
    mutating: true,
    params: integrationsVerifyParams,
    prepare: async (ctx) => {
      await requireOwner(ctx.pool, ctx.room_id, ctx.principal.participant_id);
      if (!options.secretStore || !options.verifyAwsRole)
        throw new CrossoverError("PROVIDER_UNAVAILABLE", "Integration verification is unavailable");
      const row = await readConnectedIntegrationSecretConfig(
        ctx.pool,
        options.secretStore,
        ctx.room_id,
        "aws",
        "PENDING",
      );
      const roleArn = row.configuration.role_arn;
      const externalId = row.configuration.external_id;
      if (!roleArn || !externalId)
        throw new CrossoverError("PROVIDER_UNAVAILABLE", "Integration credential is unavailable");
      let connected: boolean;
      try {
        connected = (
          await options.verifyAwsRole({
            room_id: ctx.room_id,
            role_arn: roleArn,
            external_id: externalId,
          })
        ).connected;
      } catch {
        connected = false;
      }
      return { connected, encrypted_secret: row.encrypted_secret };
    },
    execute: async (ctx) => {
      await requireOwner(ctx.client, ctx.room_id, ctx.principal.participant_id);
      const prepared = ctx.prepared as
        { connected: boolean; encrypted_secret: EncryptedSecret } | undefined;
      if (!prepared)
        throw new CrossoverError("PROVIDER_UNAVAILABLE", "Integration verification failed");
      const status: IntegrationConnectionStatus = prepared.connected ? "CONNECTED" : "PENDING";
      const statusReason = prepared.connected ? null : "assume_role_failed";
      const { rowCount } = await ctx.client.query(
        `UPDATE integrations SET status = $3, status_reason = $4,
           connected_at = CASE WHEN $3 = 'CONNECTED' THEN clock_timestamp() ELSE NULL END,
           updated_at = clock_timestamp()
         WHERE room_id = $1 AND provider = 'aws' AND status = 'PENDING'
           AND encrypted_secret = $2::jsonb`,
        [ctx.room_id, JSON.stringify(prepared.encrypted_secret), status, statusReason],
      );
      if (!(rowCount ?? 0))
        throw new CrossoverError("CONFLICT_VERSION", "The AWS integration changed; retry verify", {
          retryable: true,
          details: { reason: "integration_changed" },
        });
      return {
        response: { provider: "aws", status, status_reason: statusReason },
        ...(prepared.connected
          ? { events: [{ type: "integration.connected", payload: { provider: "aws" } }] }
          : {}),
      };
    },
  });

  dispatcher.registerCommand({
    method: "integrations.disconnect",
    action: "integrations.manage",
    mutating: true,
    params: integrationsDisconnectParams,
    execute: async (ctx, params) => {
      await requireOwner(ctx.client, ctx.room_id, ctx.principal.participant_id);
      const { rowCount } = await ctx.client.query(
        "DELETE FROM integrations WHERE room_id = $1 AND provider = $2",
        [ctx.room_id, params.provider],
      );
      const disconnected = (rowCount ?? 0) > 0;
      return {
        response: { provider: params.provider, disconnected },
        events: disconnected
          ? [{ type: "integration.disconnected", payload: { provider: params.provider } }]
          : [],
      };
    },
  });

  dispatcher.registerCommand({
    method: "integrations.list",
    action: "integrations.read",
    mutating: false,
    view: "participant",
    params: integrationsListParams,
    execute: async (ctx) => {
      const { rows: actor } = await ctx.client.query<{
        authority: string;
        owner_id: string;
      }>(
        `SELECT p.authority, r.owner_id
         FROM participants p JOIN rooms r ON r.id = p.room_id
         WHERE p.id = $1 AND p.room_id = $2`,
        [ctx.principal.participant_id, ctx.room_id],
      );
      const maySeeConfig =
        actor[0]?.owner_id === ctx.principal.participant_id || actor[0]?.authority === "ADMIN";
      const { rows } = await ctx.client.query<IntegrationRow>(
        `SELECT provider, status, status_reason, public_config, connected_at, connected_by
         FROM integrations WHERE room_id = $1 ORDER BY provider COLLATE "C"`,
        [ctx.room_id],
      );
      return {
        response: {
          integrations: rows.map((row) => ({
            provider: row.provider,
            status: row.status,
            status_reason: row.status_reason,
            connected_at: iso(row.connected_at),
            connected_by: row.connected_by,
            ...(maySeeConfig ? { config: row.public_config } : {}),
          })),
        },
      };
    },
  });
}

async function prepareConnection(
  ctx: PrepareContext,
  params: z.infer<typeof integrationsConnectParams>,
  options: IntegrationCommandsOptions,
): Promise<PreparedConnection> {
  await requireOwner(ctx.pool, ctx.room_id, ctx.principal.participant_id);
  if (params.provider === "github") {
    if (!options.secretStore)
      throw new CrossoverError("PROVIDER_UNAVAILABLE", "Integration secret storage is unavailable");
    const pendingStore = options.githubPendingConnections;
    if (!pendingStore)
      throw new CrossoverError("PROVIDER_UNAVAILABLE", "GitHub integration is unavailable");
    const binding = { room_id: ctx.room_id, owner_participant_id: ctx.principal.participant_id };
    let pending: GitHubPendingConnection | undefined;
    try {
      pending = await pendingStore.peek(params.pending_id!, binding);
    } catch {
      throw new CrossoverError("PROVIDER_UNAVAILABLE", "GitHub integration is unavailable");
    }
    const invalidPending = () =>
      new CrossoverError("VALIDATION", "GitHub installation could not be verified");
    const expiry = pending ? Date.parse(pending.expires_at) : NaN;
    if (
      !pending ||
      pending.room_id !== ctx.room_id ||
      pending.owner_participant_id !== ctx.principal.participant_id ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      !/^[1-9]\d{0,15}$/.test(pending.installation_id) ||
      !pending.repositories.length
    ) {
      throw invalidPending();
    }
    const available = new Map<string, string>();
    for (const repository of pending.repositories) {
      const name = repository.name.toLowerCase();
      if (
        !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(name) ||
        !/^[1-9]\d{0,19}$/.test(repository.id) ||
        available.has(name)
      ) {
        throw invalidPending();
      }
      available.set(name, repository.id);
    }
    const repositories = params.repositories!.map((repo) => repo.toLowerCase());
    if (new Set(repositories).size !== repositories.length) throw invalidPending();
    const repositoryIds = repositories.map((name) => available.get(name));
    if (repositoryIds.some((id) => id === undefined)) throw invalidPending();
    let consumed: GitHubPendingConnection | undefined;
    try {
      consumed = await pendingStore.consume(params.pending_id!, binding);
    } catch {
      throw new CrossoverError("PROVIDER_UNAVAILABLE", "GitHub integration is unavailable");
    }
    const consumedExpiry = consumed ? Date.parse(consumed.expires_at) : NaN;
    if (
      !consumed ||
      consumed.room_id !== ctx.room_id ||
      consumed.owner_participant_id !== ctx.principal.participant_id ||
      !Number.isFinite(consumedExpiry) ||
      consumedExpiry <= Date.now()
    ) {
      throw invalidPending();
    }
    const consumedRepositories = new Map(
      consumed.repositories.map((repository) => [repository.name.toLowerCase(), repository.id]),
    );
    const consumedRepositoryIds = repositories.map((name) => consumedRepositories.get(name));
    if (
      consumedRepositoryIds.some((id) => id === undefined) ||
      consumed.installation_id !== pending.installation_id ||
      consumedRepositoryIds.some((id, index) => id !== repositoryIds[index])
    ) {
      throw invalidPending();
    }
    const wrappedKeyResult = await ctx.pool.query<IntegrationKeyRow>(
      "SELECT key_strategy, wrapped_data_key FROM integration_room_keys WHERE room_id = $1",
      [ctx.room_id],
    );
    const { rows: existing } = wrappedKeyResult;
    const installationId = consumed.installation_id;
    const publicConfig = { installation_id: installationId, repositories };
    let encrypted: EncryptedSecret;
    try {
      encrypted = await options.secretStore.seal(
        ctx.room_id,
        "github",
        JSON.stringify({
          installation_id: installationId,
          repositories_json: JSON.stringify(repositories),
          repository_ids_json: JSON.stringify(consumedRepositoryIds),
        }),
        existing[0]?.wrapped_data_key,
      );
    } catch {
      throw new CrossoverError("PROVIDER_UNAVAILABLE", "Integration secret storage is unavailable");
    }
    return {
      provider: "github",
      status: "CONNECTED",
      status_reason: null,
      public_config: publicConfig,
      encrypted_secret: encrypted,
      connected_at: new Date().toISOString(),
    };
  }
  if (!options.secretStore) {
    throw new CrossoverError("PROVIDER_UNAVAILABLE", "Integration secret storage is unavailable");
  }
  const { rows } = await ctx.pool.query<IntegrationKeyRow>(
    "SELECT key_strategy, wrapped_data_key FROM integration_room_keys WHERE room_id = $1",
    [ctx.room_id],
  );
  const wrappedKey = rows[0]?.wrapped_data_key;
  let status: IntegrationConnectionStatus;
  let statusReason: string | null;
  let publicConfig: Record<string, unknown>;
  let secretConfig: Record<string, unknown>;
  let connectedAt: string | null;
  let externalId: string | undefined;

  if (params.provider === "aws") {
    externalId = randomBytes(32).toString("base64url");
    let verified = false;
    let verificationAttempted = false;
    if (options.verifyAwsRole) {
      verificationAttempted = true;
      try {
        verified = (
          await options.verifyAwsRole({
            room_id: ctx.room_id,
            role_arn: params.role_arn!,
            external_id: externalId,
          })
        ).connected;
      } catch {
        verified = false;
      }
    }
    status = verified ? "CONNECTED" : "PENDING";
    statusReason = verified
      ? null
      : verificationAttempted
        ? "assume_role_failed"
        : "verification_pending";
    connectedAt = verified ? new Date().toISOString() : null;
    publicConfig = { role_arn: params.role_arn! };
    secretConfig = { external_id: externalId, role_arn: params.role_arn! };
  } else {
    const expired =
      params.expires_at !== undefined && new Date(params.expires_at).getTime() <= Date.now();
    status = expired ? "EXPIRED" : "CONNECTED";
    statusReason = expired ? "token_expired" : null;
    connectedAt = expired ? null : new Date().toISOString();
    publicConfig = {};
    secretConfig = {
      access_token: params.access_token!,
      ...(params.expires_at ? { expires_at: params.expires_at } : {}),
    };
  }

  let encrypted: EncryptedSecret;
  try {
    encrypted = await options.secretStore.seal(
      ctx.room_id,
      params.provider,
      JSON.stringify(secretConfig),
      wrappedKey,
    );
  } catch {
    throw new CrossoverError("PROVIDER_UNAVAILABLE", "Integration secret storage is unavailable");
  }
  return {
    provider: params.provider,
    status,
    status_reason: statusReason,
    public_config: publicConfig,
    encrypted_secret: encrypted,
    connected_at: connectedAt,
    ...(externalId ? { external_id: externalId } : {}),
  };
}

async function requireOwner(
  client: Pool | PoolClient,
  roomId: string,
  participantId: string,
): Promise<void> {
  const { rows } = await client.query<{
    owner_id: string;
    authority: string;
    kind: string;
  }>(
    `SELECT r.owner_id, p.authority, p.kind
     FROM rooms r JOIN participants p ON p.id = $2 AND p.room_id = r.id
     WHERE r.id = $1 FOR SHARE OF r, p`,
    [roomId, participantId],
  );
  const row = rows[0];
  if (row?.owner_id !== participantId || row.authority !== "OWNER" || row.kind !== "HUMAN") {
    throw new CrossoverError("FORBIDDEN", "Only the room owner can manage integrations", {
      details: { reason: "owner_only" },
    });
  }
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
