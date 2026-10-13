import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { type ToolInvocation, ToolRegistry } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import { invokeDocker, type PluginDockerInvoker } from "./plugin-runner-docker.js";
import { DockerToolRunner } from "./plugin-runner.js";

const PLUGIN_IMAGE =
  "busybox:1.36.1-musl@sha256:3c6ae8008e2c2eedd141725c30b20d9c36b026eb796688f88205845ef17aa213";
const NODE_IMAGE =
  "node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392";
const PROXY_IMAGE = "crossover-egress-proxy:test";
const PROXY_SECRET = "0123456789abcdef0123456789abcdef";
const CREDENTIAL = "plugin-runner-integration-token";
const dockerImagesAvailable = [PLUGIN_IMAGE, NODE_IMAGE, PROXY_IMAGE].every((image) => {
  try {
    execFileSync("docker", ["image", "inspect", image], {
      stdio: "ignore",
      timeout: 1_000,
    });
    return true;
  } catch {
    return false;
  }
});
const skipDockerIntegration = !dockerImagesAvailable && !process.env["CI"];

describe.skipIf(skipDockerIntegration)("DockerToolRunner real Docker integration", () => {
  let db: TestDatabase;
  let proxyContainer: string;
  let roomId: string;
  let participantId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    roomId = `room_${randomBytes(12).toString("hex")}`;
    participantId = `part_${randomBytes(12).toString("hex")}`;
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id, settings)
       VALUES ($1, $1, 'plugin runner test', 'exercise isolated tools', $2, '{}')`,
      [roomId, participantId],
    );
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, 'HUMAN', 'Owner', 'OWNER', 'LEAD', 'ACTIVE')`,
      [participantId, roomId],
    );

    const baseDatabaseUrl =
      process.env["DATABASE_URL"] ?? "postgres://crossover:crossover@localhost:5432/crossover";
    const proxyDatabaseUrl = new URL(baseDatabaseUrl);
    proxyDatabaseUrl.pathname = `/${db.name}`;
    if (["localhost", "127.0.0.1", "::1"].includes(proxyDatabaseUrl.hostname))
      proxyDatabaseUrl.hostname = "host.docker.internal";

    proxyContainer = `crossover-plugin-proxy-test-${process.pid}`;
    execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        proxyContainer,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--add-host",
        "private.plugin.test:127.0.0.1",
        "--env",
        `DATABASE_URL=${proxyDatabaseUrl}`,
        "--env",
        `SANDBOX_EGRESS_PROXY_SECRET=${PROXY_SECRET}`,
        "--env",
        "EGRESS_PROXY_HOST=0.0.0.0",
        "--env",
        "EGRESS_PROXY_PORT=3128",
        PROXY_IMAGE,
      ],
      { stdio: "ignore", timeout: 20_000 },
    );
  }, 60_000);

  afterAll(async () => {
    if (proxyContainer) {
      try {
        execFileSync("docker", ["rm", "--force", proxyContainer], {
          stdio: "ignore",
          timeout: 10_000,
        });
      } catch {
        // The proxy may not have started; cleanup is idempotent.
      }
    }
    if (db) await db.drop();
  });

  it("exposes only the runner environment inside a real unprivileged container", async () => {
    const script = [
      "unset PWD SHLVL",
      "names=$(/bin/busybox env | /bin/busybox cut -d= -f1 | /bin/busybox sort)",
      `printf '{"result":['`,
      "separator=''",
      'for name in $names; do printf \'%s"%s"\' "$separator" "$name"; separator=,; done',
      "printf ']} '",
    ].join("; ");
    const runner = createRunner(["/bin/busybox", "sh", "-c", script], []);
    try {
      const output = await runner.run(invocation(), new AbortController().signal);
      expect(output.result).toEqual(["GITHUB_TOKEN", "HOME", "HOSTNAME", "PATH"]);
    } finally {
      await runner.close();
    }
  }, 30_000);

  it("allows a declared public host and refuses an undeclared host and a private address", async () => {
    const script = [
      'const http = require("node:http");',
      "const proxy = new URL(process.env.HTTPS_PROXY);",
      'const authorization = "Basic " + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64");',
      "function probe(host) { return new Promise((resolve) => {",
      '  const request = http.request({ host: proxy.hostname, port: Number(proxy.port), method: "CONNECT", path: `${host}:443`, headers: { "Proxy-Authorization": authorization } });',
      '  request.once("connect", (response, socket) => { socket.destroy(); resolve(response.statusCode); });',
      '  request.once("error", () => resolve(0));',
      "  request.setTimeout(5000, () => { request.destroy(); resolve(0); });",
      "  request.end();",
      "}); }",
      "(async () => {",
      '  const declared = await probe("example.com");',
      '  const undeclared = await probe("registry.npmjs.org");',
      '  const private = await probe("private.plugin.test");',
      "  const environment = Object.keys(process.env).sort();",
      "  process.stdout.write(JSON.stringify({ result: { declared, undeclared, private, environment } }));",
      "})().catch(() => process.exit(1));",
    ].join("\n");
    const runner = createRunner(
      ["node", "-e", script],
      ["example.com", "private.plugin.test"],
      10_000,
      undefined,
      NODE_IMAGE,
    );
    try {
      const output = await runner.run(invocation(), new AbortController().signal);
      expect(output.result).toMatchObject({ declared: 200, undeclared: 403, private: 403 });
      const { environment } = output.result as { environment: string[] };
      expect(environment).toEqual(
        expect.arrayContaining([
          "ALL_PROXY",
          "GITHUB_TOKEN",
          "HOME",
          "HOSTNAME",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "NO_PROXY",
          "PATH",
          "all_proxy",
          "http_proxy",
          "https_proxy",
          "no_proxy",
        ]),
      );
      expect(environment).not.toContain("DATABASE_URL");
      expect(environment).not.toContain("REDIS_URL");
      expect(
        environment.every((name) =>
          [
            "ALL_PROXY",
            "GITHUB_TOKEN",
            "HOME",
            "HOSTNAME",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
            "NODE_VERSION",
            "PATH",
            "PWD",
            "YARN_VERSION",
            "all_proxy",
            "http_proxy",
            "https_proxy",
            "no_proxy",
          ].includes(name),
        ),
      ).toBe(true);
      const logs = execFileSync("docker", ["logs", proxyContainer], {
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(logs).toContain('"host":"example.com","allowed":true');
      expect(logs).toContain('"host":"registry.npmjs.org","allowed":false');
      expect(logs).toContain('"host":"private.plugin.test","allowed":false');
      expect(logs).toContain('"plugin_invocation_id":"cmd_');
      expect(logs).not.toContain(PROXY_SECRET);
      expect(logs).not.toContain(CREDENTIAL);
    } finally {
      await runner.close();
    }
  }, 45_000);

  it("kills a timed-out plugin and leaves no labeled container behind", async () => {
    let containerName: string | undefined;
    const invoke: PluginDockerInvoker = (binary, args, options) => {
      if (args[0] === "run") {
        const nameIndex = args.indexOf("--name");
        if (nameIndex !== -1) containerName = args[nameIndex + 1];
      }
      return invokeDocker(binary, args, options);
    };
    const runner = createRunner(
      ["/bin/busybox", "sleep", "60"],
      [],
      1_500,
      undefined,
      PLUGIN_IMAGE,
      invoke,
    );
    try {
      await expect(runner.run(invocation(), new AbortController().signal)).rejects.toThrow(
        /timed out/,
      );
      expect(containerName).toMatch(/^crossover-plugin-[a-f0-9]{24}$/);
      const containers = execFileSync(
        "docker",
        ["ps", "-a", "--filter", `name=^/${containerName}$`, "--format", "{{.ID}}"],
        { encoding: "utf8", timeout: 5_000 },
      );
      expect(containers.trim(), `container ${containerName} should be removed`).toBe("");
    } finally {
      await runner.close();
    }
  }, 30_000);

  it("removes stale labeled containers and networks during startup cleanup", async () => {
    const suffix = randomBytes(6).toString("hex");
    const staleContainer = `crossover-plugin-stale-${suffix}`;
    const staleNetwork = `crossover-plugin-net-stale-${suffix}`;
    execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        staleContainer,
        "--network",
        "none",
        "--label",
        "crossover.plugin-run=true",
        "--label",
        "crossover.plugin-run-created-at=0",
        PLUGIN_IMAGE,
        "/bin/busybox",
        "sleep",
        "300",
      ],
      { stdio: "ignore", timeout: 10_000 },
    );
    execFileSync(
      "docker",
      [
        "network",
        "create",
        "--internal",
        "--label",
        "crossover.plugin-run=true",
        "--label",
        "crossover.plugin-run-created-at=0",
        staleNetwork,
      ],
      { stdio: "ignore", timeout: 10_000 },
    );
    const runner = createRunner(["/bin/busybox", "true"], [], 5_000, true);
    try {
      await runner.sweepStaleResources();
      await expect
        .poll(
          () =>
            execFileSync(
              "docker",
              ["ps", "-a", "--filter", `name=${staleContainer}`, "--format", "{{.ID}}"],
              { encoding: "utf8", timeout: 5_000 },
            ).trim(),
          { timeout: 5_000 },
        )
        .toBe("");
      await expect
        .poll(
          () =>
            execFileSync(
              "docker",
              ["network", "ls", "--filter", `name=${staleNetwork}`, "--format", "{{.ID}}"],
              { encoding: "utf8", timeout: 5_000 },
            ).trim(),
          { timeout: 5_000 },
        )
        .toBe("");
    } finally {
      await runner.close();
      try {
        execFileSync("docker", ["rm", "--force", staleContainer], { stdio: "ignore" });
      } catch {
        // The sweeper may already have removed it.
      }
      try {
        execFileSync("docker", ["network", "rm", staleNetwork], { stdio: "ignore" });
      } catch {
        // The sweeper may already have removed it.
      }
    }
  }, 30_000);

  function createRunner(
    command: readonly string[],
    egressHosts: readonly string[],
    timeoutMs = 10_000,
    sweepResources?: boolean,
    image = PLUGIN_IMAGE,
    invoke: PluginDockerInvoker = invokeDocker,
  ): DockerToolRunner {
    const registry = new ToolRegistry();
    registry.register({
      name: "test.run",
      description: "Docker integration fixture",
      capability: "test.run",
      tier: 0,
      input: z.object({}),
      idempotent: true,
      execution: { image, command, egressHosts },
    });
    return new DockerToolRunner({
      registry,
      egressProxyContainer: proxyContainer,
      egressProxySecret: PROXY_SECRET,
      credentials: async () => ({ GITHUB_TOKEN: CREDENTIAL }),
      timeoutMs,
      sweepResources: sweepResources ?? true,
      invoke,
    });
  }

  function invocation(): ToolInvocation {
    return {
      tool: "test.run",
      args: {},
      capability: "test.run",
      scope: undefined,
      room_id: roomId,
      participant_id: participantId,
      invocation_id: newId("cmd"),
    };
  }
});
