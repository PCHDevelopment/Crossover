import { hostname } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_HEALTH_IMAGE, type DiskEnforcementMode } from "@crossover/workspace";

const flag = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

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
  /** Behind a reverse proxy: take the client address from `X-Forwarded-For` (per-IP limits). */
  TRUST_PROXY: flag,
  /** Refresh attempts per client address per minute (`POST /v1/auth/refresh`). Default 30. */
  REFRESH_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(30),
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
  trustProxy?: boolean;
  refreshPerMinute?: number;
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
  /** Shared HMAC secret for per-sandbox egress proxy credentials. */
  sandboxEgressProxySecret?: string;
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
  if (
    sandboxDiskEnforcement === "hard" &&
    (!e.SANDBOX_VOLUME_DRIVER || Object.keys(sandboxVolumeOptions).length === 0)
  ) {
    throw new Error(
      "Invalid server configuration:\n  SANDBOX_DISK_ENFORCEMENT=hard requires SANDBOX_VOLUME_DRIVER and SANDBOX_VOLUME_OPTS (a nonempty JSON object)",
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
    trustProxy: e.TRUST_PROXY,
    refreshPerMinute: e.REFRESH_PER_MINUTE,
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
