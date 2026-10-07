import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  SANDBOX_EGRESS_PROXY_SECRET: z.string().min(32),
  EGRESS_PROXY_HOST: z.string().min(1).default("0.0.0.0"),
  EGRESS_PROXY_PORT: z.coerce.number().int().min(1).max(65_535).default(3128),
});

export interface EgressProxyConfig {
  databaseUrl: string;
  secret: string;
  host: string;
  port: number;
}

/** Parse the proxy's dedicated process configuration and fail closed on missing secrets. */
export function loadEgressProxyConfig(env: NodeJS.ProcessEnv = process.env): EgressProxyConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid egress proxy configuration:\n  ${problems.join("\n  ")}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    secret: parsed.data.SANDBOX_EGRESS_PROXY_SECRET,
    host: parsed.data.EGRESS_PROXY_HOST,
    port: parsed.data.EGRESS_PROXY_PORT,
  };
}
