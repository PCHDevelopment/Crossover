import { createPool, migrate } from "@crossover/db";
import { initPolicy } from "@crossover/policy";
import { assertGitVersion, DEFAULT_GIT_INTERNAL_NETWORK } from "@crossover/workspace";
import { composeServer } from "./compose.js";
import { loadConfig } from "./config.js";
import { resolveGitInternalListenHost } from "./git-internal-listener.js";

/**
 * Start Crossover: check Git (≥ 2.40), apply pending migrations, compose, listen. SIGINT and
 * SIGTERM shut down gracefully, releasing this node's leases so another node can take the
 * rooms over at once.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  console.warn("single-host mode: not for multi-tenant or untrusted use (ARCHITECTURE §4.1)");
  if (config.allowUnsandboxedDev) {
    console.warn("ALLOW_UNSANDBOXED_DEV=1: sandboxes run WITHOUT gVisor (development only)");
  }
  await assertGitVersion();

  const migrationPool = createPool(config.databaseUrl);
  try {
    const applied = await migrate(migrationPool);
    if (applied.length) console.warn(`Applied migrations: ${applied.join(", ")}`);
  } finally {
    await migrationPool.end();
  }

  // The authorization policy (D9) is loaded before anything is served; its digest in the log
  // tells a deploy which policy it runs.
  const policy = await initPolicy();
  console.warn(`Authorization policy policy.wasm sha256=${policy.sha256} (${policy.bytes} bytes)`);

  const server = await composeServer(config);
  if (config.gitInternalTokenSecret) {
    const gitInternalHost = await resolveGitInternalListenHost(
      config.gitInternalHost!,
      config.gitInternalContainer!,
      config.gitInternalNetwork ?? DEFAULT_GIT_INTERNAL_NETWORK,
    );
    const address = await server.gitApp.listen({
      host: gitInternalHost,
      port: config.gitInternalPort ?? 8081,
    });
    console.warn(`Internal Git listener bound on ${address}; do not publish this port`);
  }
  const address = await server.app.listen({ host: config.host, port: config.port });
  console.warn(`Crossover ${config.nodeId} listening on ${address}`);

  const shutdown = (signal: string) => {
    console.warn(`${signal}: shutting down`);
    server.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error("Shutdown failed", err);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
