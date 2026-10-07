import { hostname } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { DEFAULT_HEALTH_IMAGE } from "@crossover/workspace";

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
  /** Comma-separated operator-approved images usable by room health checks. */
  HEALTH_IMAGES: z
    .string()
    .optional()
    .transform((value) => (value ?? DEFAULT_HEALTH_IMAGE).split(",").map((image) => image.trim()))
    .refine((images) => images.length > 0 && images.every(Boolean), {
      message: "must contain one or more nonempty image names",
    }),
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
  /** Operator allowlist for room-selected health container images. */
  healthImages: readonly string[];
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
  return {
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    workspaceRoot: resolve(e.WORKSPACE_ROOT),
    host: e.HOST,
    port: e.PORT,
    nodeId: e.NODE_ID ?? `${hostname()}-${process.pid}`,
    devLogin: e.DEV_LOGIN,
    healthImages: e.HEALTH_IMAGES,
  };
}
