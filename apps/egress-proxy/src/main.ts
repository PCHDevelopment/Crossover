import { createPool } from "@crossover/db";
import { loadEgressProxyConfig } from "./config.js";
import { createEgressProxyServer } from "./server.js";

process.on("uncaughtException", (error: unknown) => {
  console.error(
    "[egress-proxy] uncaught exception",
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exit(1);
});

async function main(): Promise<void> {
  const config = loadEgressProxyConfig();
  const pool = createPool(config.databaseUrl);
  const server = createEgressProxyServer({ pool, secret: config.secret });
  server.once("error", (error) => {
    console.error("[egress-proxy] listener failed", error.message);
    void pool.end().finally(() => process.exit(1));
  });
  server.listen(config.port, config.host, () => {
    process.stdout.write(
      `${JSON.stringify({ event: "egress_proxy_started", host: config.host, port: config.port })}\n`,
    );
  });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`${JSON.stringify({ event: "egress_proxy_stopping", signal })}\n`);
    server.close((error) => {
      void pool.end().then(
        () => {
          if (error) {
            console.error("[egress-proxy] listener shutdown failed", error.message);
            process.exitCode = 1;
          }
        },
        (poolError: unknown) => {
          console.error(
            "[egress-proxy] database shutdown failed",
            poolError instanceof Error ? poolError.message : "unknown error",
          );
          process.exitCode = 1;
        },
      );
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("[egress-proxy] startup failed", error instanceof Error ? error.message : error);
  process.exit(1);
});
