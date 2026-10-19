import { isIP } from "node:net";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import {
  DEFAULT_GIT_INTERNAL_NETWORK,
  DEFAULT_HEALTH_IMAGE,
  type DiskEnforcementMode,
} from "@crossover/workspace";

const flag = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

/** Compose's optional pass-through values are empty strings when unset. */
const optionalEnv = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/** An IP address, or an address with a CIDR prefix length. */
function isProxyAddress(entry: string): boolean {
  const [address, length, ...rest] = entry.split("/");
  const version = isIP(address ?? "");
  if (version === 0 || rest.length > 0) return false;
  if (length === undefined) return true;
  return /^\d{1,3}$/.test(length) && Number(length) <= (version === 4 ? 32 : 128);
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WORKSPACE_ROOT: z.string().min(1),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65_535).default(8080),
  /** Unique per process (`room_leases.node_id`). Default: host name plus process id. */
  NODE_ID: z.string().min(1).max(200).optional(),
  /** Serve `POST /v1/auth/dev-login`. Development only; off unless set. */
  DEV_LOGIN: flag,
  /** Explicitly permit the no-credential development login when NODE_ENV=production. */
  DEV_LOGIN_ALLOW_PRODUCTION: flag,
  /** Development-only opt-out of the required gVisor runtime for single-host sandboxes. */
  ALLOW_UNSANDBOXED_DEV: z.literal("1").optional(),
  /** Public origin used for exact OAuth callback URLs; required with OAuth credentials. */
  OAUTH_PUBLIC_BASE_URL: z.string().url().optional(),
  GITHUB_OAUTH_CLIENT_ID: z.string().trim().min(1).max(200).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).max(4096).optional(),
  GOOGLE_OAUTH_CLIENT_ID: z.string().trim().min(1).max(200).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).max(4096).optional(),
  /** Reverse proxies in front of the server (comma-separated addresses or CIDRs): the client address is the first `X-Forwarded-For` hop that is not one of them. Default: none. */
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const entries = v
        ? v
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean)
        : [];
      for (const entry of entries) {
        if (!isProxyAddress(entry)) {
          ctx.addIssue({
            code: "custom",
            message: `TRUST_PROXY: "${entry}" is not an IP address or CIDR (comma-separated, e.g. 10.0.0.0/8,127.0.0.1)`,
          });
        }
      }
      return entries;
    }),
  /** Refresh requests and OAuth starts per client address per minute. Default 30. */
  REFRESH_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(30),
  /** Milliseconds between conflict-rate reports on stdout (T1586); 0 turns the report off. */
  CONFLICT_REPORT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(2_147_483_647)
    .default(86_400_000),
  /** Serve the built web app (`apps/web/dist`) from this directory next to the API. */
  WEB_ROOT: z.string().min(1).optional(),
  /** Comma-separated operator-approved images usable by room health checks. */
  HEALTH_IMAGES: z
    .string()
    .optional()
    .transform((value) => (value ?? DEFAULT_HEALTH_IMAGE).split(",").map((image) => image.trim()))
    .refine((images) => images.length > 0 && images.every(Boolean), {
      message: "must contain one or more nonempty image names",
    }),
  SANDBOX_DISK_ENFORCEMENT: z.enum(["hard", "soft"]).optional(),
  SANDBOX_VOLUME_DRIVER: z.string().trim().min(1).optional(),
  SANDBOX_VOLUME_OPTS: z.string().optional(),
  SANDBOX_RUNTIME: z.string().trim().min(1).optional(),
  SANDBOX_EGRESS_PROXY_CONTAINER: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_.-]*$/)
    .optional(),
  SANDBOX_EGRESS_PROXY_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  SANDBOX_EGRESS_PROXY_SECRET: z.string().min(32).optional(),
  /** 32-byte hex key for development integration-secret encryption. */
  INTEGRATION_SECRET_KEY: optionalEnv(z.string().regex(/^[a-fA-F0-9]{64}$/)),
  /** AWS KMS key id or ARN used for production integration-secret envelope encryption. */
  INTEGRATION_KMS_KEY_ID: optionalEnv(z.string().trim().min(1)),
  GITHUB_APP_ID: optionalEnv(z.string().regex(/^[1-9]\d{0,19}$/)),
  GITHUB_APP_SLUG: optionalEnv(
    z
      .string()
      .trim()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/),
  ),
  GITHUB_CLIENT_ID: optionalEnv(z.string().trim().min(1).max(200)),
  GITHUB_CLIENT_SECRET: optionalEnv(z.string().min(1).max(4096)),
  GITHUB_APP_PRIVATE_KEY: optionalEnv(z.string().min(100).max(16_384)),
  /** Operator-provisioned immutable GitHub plugin worker image. */
  GITHUB_PLUGIN_IMAGE: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,254}@sha256:[a-f0-9]{64}$/)
    .optional(),
  /** Operator-provisioned immutable browser plugin worker image. */
  BROWSER_PLUGIN_IMAGE: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,254}@sha256:[a-f0-9]{64}$/)
    .optional(),
  /** Operator-provisioned immutable AWS plugin worker image. */
  AWS_PLUGIN_IMAGE: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,254}@sha256:[a-f0-9]{64}$/)
    .optional(),
  GIT_INTERNAL_HOST: z.string().trim().min(1).optional(),
  /** Docker network shared by the server's private Git listener and one-shot fetchers. */
  GIT_INTERNAL_NETWORK: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,127}$/)
    .default(DEFAULT_GIT_INTERNAL_NETWORK),
  GIT_INTERNAL_PORT: z.coerce.number().int().min(1).max(65_535).default(8081),
  GIT_INTERNAL_CONTAINER: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_.-]*$/)
    .optional(),
  GIT_INTERNAL_TOKEN_SECRET: z.string().min(32).optional(),
  GIT_FETCHER_IMAGE: z.string().trim().min(1).default("crossover-git-fetcher:latest"),
  /** The key agents' wake-up webhooks are signed with (derived per agent, §17.4). Off without it. */
  WAKE_WEBHOOK_KEY: z.string().min(32).optional(),
});

export interface ServerConfig {
  databaseUrl: string;
  redisUrl: string;
  /** Absolute; each room's bare repository lives under it. */
  workspaceRoot: string;
  host: string;
  port: number;
  nodeId: string;
  devLogin: boolean;
  /** The local-development exception that permits sandboxes without gVisor. */
  allowUnsandboxedDev?: boolean;
  /** Secure cookie mode follows the public HTTPS origin, with production as a safe fallback. */
  secureCookies?: boolean;
  oauth?: {
    publicBaseUrl: string;
    github?: { clientId: string; clientSecret: string };
    google?: { clientId: string; clientSecret: string };
  };
  trustProxy?: string[];
  /** Per-address limit for refresh requests and OAuth starts. */
  refreshPerMinute?: number;
  /** Milliseconds between conflict-rate reports (T1586); 0 turns them off. Default one day. */
  conflictReportIntervalMs?: number;
  /** Directory of the built web app, served next to the API. */
  webRoot?: string;
  /** Operator allowlist for room-selected health container images. */
  healthImages: readonly string[];
  /** Production defaults to hard; development and CI default to soft. */
  sandboxDiskEnforcement?: DiskEnforcementMode;
  sandboxVolumeDriver?: string;
  sandboxVolumeOptions?: Readonly<Record<string, string>>;
  /** Optional Docker runtime, e.g. gVisor's `runsc`. */
  sandboxRuntime?: string;
  /** Operator-provisioned HTTP allowlist proxy; absent means network-none sandboxes. */
  sandboxEgressProxyContainer?: string;
  sandboxEgressProxyPort?: number;
  /** Shared HMAC secret for sandbox, health-install and short-lived plugin proxy credentials. */
  sandboxEgressProxySecret?: string;
  /** Development-only master key for room-scoped integration secret encryption. */
  integrationSecretKey?: Uint8Array;
  /** KMS key id or ARN for production room-scoped integration secret encryption. */
  integrationKmsKeyId?: string;
  githubApp?: {
    appId: string;
    slug: string;
    clientId: string;
    clientSecret: string;
    privateKey: string;
  };
  /** Digest-pinned isolated GitHub worker image; GitHub tools are unavailable when unset. */
  githubPluginImage?: string;
  /** Digest-pinned isolated browser worker image; browser tools are unavailable when unset. */
  browserPluginImage?: string;
  /** Digest-pinned isolated AWS worker image; AWS tools are unavailable when unset. */
  awsPluginImage?: string;
  /** Bind address and private, unpublished port of the internal Git-only listener. */
  gitInternalHost?: string;
  gitInternalPort?: number;
  /** Trusted server container connected to crossover-git for one-shot fetchers. */
  gitInternalContainer?: string;
  /** Docker network shared by the server's private Git listener and one-shot fetchers. */
  gitInternalNetwork?: string;
  /** HMAC key accepted only by the internal Git listener. */
  gitInternalTokenSecret?: string;
  gitFetcherImage?: string;
  /** Platform key wake-up webhook secrets are derived from; no wake-ups without it. */
  wakeWebhookKey?: string;
}

/**
 * Read the server's configuration from the environment (`.env.example` lists the variables).
 * A missing or malformed variable fails startup with every problem named, not just the first.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid server configuration:\n  ${problems.join("\n  ")}`);
  }
  const e = parsed.data;
  const invalidConfig = (message: string): never => {
    throw new Error(`Invalid server configuration:\n  ${message}`);
  };
  if (env.NODE_ENV === "production" && e.DEV_LOGIN && !e.DEV_LOGIN_ALLOW_PRODUCTION) {
    invalidConfig("DEV_LOGIN is forbidden in production unless DEV_LOGIN_ALLOW_PRODUCTION=true");
  }
  if (e.SANDBOX_RUNTIME !== "runsc" && e.ALLOW_UNSANDBOXED_DEV !== "1") {
    invalidConfig(
      "SANDBOX_RUNTIME=runsc is required: sandboxes share this host (single-host mode, ARCHITECTURE §4.1). Set ALLOW_UNSANDBOXED_DEV=1 only for local development.",
    );
  }
  if (e.ALLOW_UNSANDBOXED_DEV === "1" && env.NODE_ENV === "production") {
    invalidConfig("ALLOW_UNSANDBOXED_DEV is refused when NODE_ENV=production");
  }
  const hasGitHubClientId = Boolean(e.GITHUB_OAUTH_CLIENT_ID);
  const hasGitHubClientSecret = Boolean(e.GITHUB_OAUTH_CLIENT_SECRET);
  if (
    hasGitHubClientId !== hasGitHubClientSecret ||
    (hasGitHubClientId && !e.OAUTH_PUBLIC_BASE_URL)
  ) {
    invalidConfig("set both GitHub OAuth credentials and OAUTH_PUBLIC_BASE_URL together");
  }
  const hasGoogleClientId = Boolean(e.GOOGLE_OAUTH_CLIENT_ID);
  const hasGoogleClientSecret = Boolean(e.GOOGLE_OAUTH_CLIENT_SECRET);
  if (
    hasGoogleClientId !== hasGoogleClientSecret ||
    (hasGoogleClientId && !e.OAUTH_PUBLIC_BASE_URL)
  ) {
    invalidConfig("set both Google OAuth credentials and OAUTH_PUBLIC_BASE_URL together");
  }
  if (e.OAUTH_PUBLIC_BASE_URL) {
    const base = new URL(e.OAUTH_PUBLIC_BASE_URL);
    if (base.pathname !== "/" || base.search || base.hash || base.username || base.password) {
      invalidConfig("OAUTH_PUBLIC_BASE_URL must be an origin without a path, query or fragment");
    }
    const localHttp =
      base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
    if ((env.NODE_ENV === "production" || !localHttp) && base.protocol !== "https:") {
      invalidConfig("OAUTH_PUBLIC_BASE_URL must use HTTPS except for localhost development");
    }
  }
  const sandboxDiskEnforcement =
    e.SANDBOX_DISK_ENFORCEMENT ?? (env.NODE_ENV === "production" ? "hard" : "soft");
  const sandboxVolumeOptions = parseVolumeOptions(e.SANDBOX_VOLUME_OPTS);
  if (e.SANDBOX_EGRESS_PROXY_PORT !== undefined && !e.SANDBOX_EGRESS_PROXY_CONTAINER)
    throw new Error(
      "Invalid server configuration:\n  SANDBOX_EGRESS_PROXY_PORT requires SANDBOX_EGRESS_PROXY_CONTAINER",
    );
  if (e.SANDBOX_EGRESS_PROXY_CONTAINER && !e.SANDBOX_EGRESS_PROXY_SECRET)
    throw new Error(
      "Invalid server configuration:\n  SANDBOX_EGRESS_PROXY_CONTAINER requires SANDBOX_EGRESS_PROXY_SECRET",
    );
  if (e.SANDBOX_EGRESS_PROXY_SECRET && !e.SANDBOX_EGRESS_PROXY_CONTAINER)
    throw new Error(
      "Invalid server configuration:\n  SANDBOX_EGRESS_PROXY_SECRET requires SANDBOX_EGRESS_PROXY_CONTAINER",
    );
  if (e.GIT_INTERNAL_CONTAINER && !e.GIT_INTERNAL_TOKEN_SECRET)
    throw new Error(
      "Invalid server configuration:\n  GIT_INTERNAL_CONTAINER requires GIT_INTERNAL_TOKEN_SECRET",
    );
  if (e.GIT_INTERNAL_TOKEN_SECRET && !e.GIT_INTERNAL_CONTAINER)
    throw new Error(
      "Invalid server configuration:\n  GIT_INTERNAL_TOKEN_SECRET requires GIT_INTERNAL_CONTAINER",
    );
  if (e.GIT_INTERNAL_TOKEN_SECRET && !e.GIT_INTERNAL_HOST)
    throw new Error(
      "Invalid server configuration:\n  GIT_INTERNAL_HOST is required when the internal Git listener is enabled",
    );
  if (e.GIT_INTERNAL_HOST === "0.0.0.0" || e.GIT_INTERNAL_HOST === "::")
    throw new Error(
      "Invalid server configuration:\n  GIT_INTERNAL_HOST must be a specific private-network address, not a wildcard",
    );
  if (
    sandboxDiskEnforcement === "hard" &&
    (!e.SANDBOX_VOLUME_DRIVER || Object.keys(sandboxVolumeOptions).length === 0)
  ) {
    throw new Error(
      "Invalid server configuration:\n  SANDBOX_DISK_ENFORCEMENT=hard requires SANDBOX_VOLUME_DRIVER and SANDBOX_VOLUME_OPTS (a nonempty JSON object)",
    );
  }
  if (env.NODE_ENV === "production" && !e.INTEGRATION_KMS_KEY_ID) {
    throw new Error(
      "Invalid server configuration:\n  INTEGRATION_KMS_KEY_ID is required in production for integration secrets",
    );
  }
  if (env.NODE_ENV === "production" && e.INTEGRATION_SECRET_KEY) {
    throw new Error(
      "Invalid server configuration:\n  INTEGRATION_SECRET_KEY is development-only; production must use KMS",
    );
  }
  const githubAppValues = [
    e.GITHUB_APP_ID,
    e.GITHUB_APP_SLUG,
    e.GITHUB_CLIENT_ID,
    e.GITHUB_CLIENT_SECRET,
    e.GITHUB_APP_PRIVATE_KEY,
  ];
  if (githubAppValues.some(Boolean) && githubAppValues.some((value) => !value)) {
    throw new Error(
      "Invalid server configuration:\n  GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and GITHUB_APP_PRIVATE_KEY must be configured together",
    );
  }
  if (githubAppValues.some(Boolean) && !e.INTEGRATION_SECRET_KEY && !e.INTEGRATION_KMS_KEY_ID) {
    invalidConfig(
      "GitHub App integration requires an integration secret store: set INTEGRATION_SECRET_KEY for local development or INTEGRATION_KMS_KEY_ID for production",
    );
  }
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    workspaceRoot: resolve(e.WORKSPACE_ROOT),
    host: e.HOST,
    port: e.PORT,
    nodeId: e.NODE_ID ?? `${hostname()}-${process.pid}`,
    devLogin: e.DEV_LOGIN,
    allowUnsandboxedDev: e.ALLOW_UNSANDBOXED_DEV === "1",
    secureCookies: e.OAUTH_PUBLIC_BASE_URL
      ? new URL(e.OAUTH_PUBLIC_BASE_URL).protocol === "https:"
      : env.NODE_ENV === "production",
    ...((hasGitHubClientId || hasGoogleClientId) && e.OAUTH_PUBLIC_BASE_URL
      ? {
          oauth: {
            publicBaseUrl: new URL(e.OAUTH_PUBLIC_BASE_URL).origin,
            ...(e.GITHUB_OAUTH_CLIENT_ID && e.GITHUB_OAUTH_CLIENT_SECRET
              ? {
                  github: {
                    clientId: e.GITHUB_OAUTH_CLIENT_ID,
                    clientSecret: e.GITHUB_OAUTH_CLIENT_SECRET,
                  },
                }
              : {}),
            ...(e.GOOGLE_OAUTH_CLIENT_ID && e.GOOGLE_OAUTH_CLIENT_SECRET
              ? {
                  google: {
                    clientId: e.GOOGLE_OAUTH_CLIENT_ID,
                    clientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET,
                  },
                }
              : {}),
          },
        }
      : {}),
    trustProxy: e.TRUST_PROXY,
    refreshPerMinute: e.REFRESH_PER_MINUTE,
    conflictReportIntervalMs: e.CONFLICT_REPORT_INTERVAL_MS,
    ...(e.WEB_ROOT ? { webRoot: resolve(e.WEB_ROOT) } : {}),
    healthImages: e.HEALTH_IMAGES,
    sandboxDiskEnforcement,
    ...(e.SANDBOX_VOLUME_DRIVER ? { sandboxVolumeDriver: e.SANDBOX_VOLUME_DRIVER } : {}),
    sandboxVolumeOptions,
    ...(e.SANDBOX_RUNTIME ? { sandboxRuntime: e.SANDBOX_RUNTIME } : {}),
    ...(e.SANDBOX_EGRESS_PROXY_CONTAINER
      ? { sandboxEgressProxyContainer: e.SANDBOX_EGRESS_PROXY_CONTAINER }
      : {}),
    ...(e.SANDBOX_EGRESS_PROXY_PORT !== undefined
      ? { sandboxEgressProxyPort: e.SANDBOX_EGRESS_PROXY_PORT }
      : {}),
    ...(e.SANDBOX_EGRESS_PROXY_SECRET
      ? { sandboxEgressProxySecret: e.SANDBOX_EGRESS_PROXY_SECRET }
      : {}),
    ...(e.INTEGRATION_SECRET_KEY
      ? { integrationSecretKey: Buffer.from(e.INTEGRATION_SECRET_KEY, "hex") }
      : {}),
    ...(e.INTEGRATION_KMS_KEY_ID ? { integrationKmsKeyId: e.INTEGRATION_KMS_KEY_ID } : {}),
    ...(e.GITHUB_APP_ID &&
    e.GITHUB_APP_SLUG &&
    e.GITHUB_CLIENT_ID &&
    e.GITHUB_CLIENT_SECRET &&
    e.GITHUB_APP_PRIVATE_KEY
      ? {
          githubApp: {
            appId: e.GITHUB_APP_ID,
            slug: e.GITHUB_APP_SLUG,
            clientId: e.GITHUB_CLIENT_ID,
            clientSecret: e.GITHUB_CLIENT_SECRET,
            privateKey: e.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
          },
        }
      : {}),
    ...(e.GITHUB_PLUGIN_IMAGE ? { githubPluginImage: e.GITHUB_PLUGIN_IMAGE } : {}),
    ...(e.BROWSER_PLUGIN_IMAGE ? { browserPluginImage: e.BROWSER_PLUGIN_IMAGE } : {}),
    ...(e.AWS_PLUGIN_IMAGE ? { awsPluginImage: e.AWS_PLUGIN_IMAGE } : {}),
    ...(e.GIT_INTERNAL_HOST ? { gitInternalHost: e.GIT_INTERNAL_HOST } : {}),
    gitInternalNetwork: e.GIT_INTERNAL_NETWORK,
    gitInternalPort: e.GIT_INTERNAL_PORT,
    ...(e.GIT_INTERNAL_CONTAINER ? { gitInternalContainer: e.GIT_INTERNAL_CONTAINER } : {}),
    ...(e.GIT_INTERNAL_TOKEN_SECRET ? { gitInternalTokenSecret: e.GIT_INTERNAL_TOKEN_SECRET } : {}),
    gitFetcherImage: e.GIT_FETCHER_IMAGE,
    ...(e.WAKE_WEBHOOK_KEY ? { wakeWebhookKey: e.WAKE_WEBHOOK_KEY } : {}),
  };
}

function parseVolumeOptions(raw: string | undefined): Readonly<Record<string, string>> {
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(
      "Invalid server configuration:\n  SANDBOX_VOLUME_OPTS must be a JSON object of Docker options",
    );
  }
  const parsed = z.record(z.string(), z.string()).safeParse(value);
  if (
    !parsed.success ||
    Object.entries(parsed.data).some(
      ([key, option]) => !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || option.length === 0,
    )
  ) {
    throw new Error(
      "Invalid server configuration:\n  SANDBOX_VOLUME_OPTS must map Docker option names to nonempty strings",
    );
  }
  return parsed.data;
}
