import { execFileSync } from "node:child_process";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { ToolRegistry, type ToolInvocation } from "@crossover/kernel";
import { newId } from "@crossover/protocol";
import { normalizeRoomEgressAllowlist } from "@crossover/security";
import { browserNavigateParams, browserReadPageParams } from "./browser-plugin.js";
import { DockerToolRunner } from "./plugin-runner.js";

const SECRET = "browser-test-proxy-secret-with-32-bytes";
const PROXY_IMAGE = "crossover-egress-proxy:test";
const BROWSER_IMAGE = "crossover-browser-plugin:test";
const dockerImagesAvailable = [PROXY_IMAGE, BROWSER_IMAGE].every((image) => {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 1_000 });
    return true;
  } catch {
    return false;
  }
});
const skipDockerIntegration = !dockerImagesAvailable && !process.env.CI;

describe.skipIf(skipDockerIntegration)("browser plugin real Docker integration", () => {
  let db: TestDatabase;
  let runner: DockerToolRunner | undefined;
  let proxyContainer: string | undefined;
  let roomId: string;
  let participantId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    roomId = newId("room");
    participantId = newId("part");
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id, settings)
       VALUES ($1, $1, 'browser plugin test', 'exercise the browser worker', $2, $3::jsonb)`,
      [roomId, participantId, JSON.stringify({ egress_allowlist: ["browser-fixture.test"] })],
    );
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, 'HUMAN', 'Owner', 'OWNER', 'LEAD', 'ACTIVE')`,
      [participantId, roomId],
    );

    const databaseUrl = new URL(
      process.env.DATABASE_URL ?? "postgres://crossover:crossover@localhost:5432/crossover",
    );
    databaseUrl.pathname = `/${db.name}`;
    if (["localhost", "127.0.0.1", "::1"].includes(databaseUrl.hostname))
      databaseUrl.hostname = "host.docker.internal";

    proxyContainer = `crossover-browser-test-proxy-${process.pid}`;
    const certDirectory = `${process.cwd()}/plugins/browser/test/certs`;
    const proxyScript = `${process.cwd()}/apps/server/src/fixtures/browser-test-proxy.mjs`;
    execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--name",
        proxyContainer,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--volume",
        `${proxyScript}:/tmp/browser-test-proxy.mjs:ro`,
        "--volume",
        `${certDirectory}/server.crt:/test-certs/server.crt:ro`,
        "--volume",
        `${certDirectory}/server.key:/test-certs/server.key:ro`,
        "--env",
        `DATABASE_URL=${databaseUrl}`,
        "--env",
        `SANDBOX_EGRESS_PROXY_SECRET=${SECRET}`,
        PROXY_IMAGE,
        "node",
        "/tmp/browser-test-proxy.mjs",
      ],
      { stdio: "ignore", timeout: 20_000 },
    );
    await waitForProxy(proxyContainer);

    const imageId = execFileSync(
      "docker",
      ["image", "inspect", BROWSER_IMAGE, "--format", "{{.Id}}"],
      {
        encoding: "utf8",
        timeout: 5_000,
      },
    ).trim();
    const registry = new ToolRegistry({
      tierOf: (capability) => (capability === "browser.navigate" ? 2 : 0),
    });
    registry.register({
      name: "browser.navigate",
      description: "Browser plugin test navigation tool",
      capability: "browser.navigate",
      tier: 2,
      input: browserNavigateParams,
      idempotent: true,
      execution: {
        image: imageId,
        command: ["node", "/app/plugins/browser/test/worker.mjs"],
        egressHosts: [],
        roomEgressAllowlist: true,
        pidsLimit: 256,
        maxOutputBytes: 256 * 1024,
      },
    });
    registry.register({
      name: "browser.read_page",
      description: "Browser plugin test page reader",
      capability: "browser.navigate",
      tier: 2,
      input: browserReadPageParams,
      idempotent: true,
      execution: {
        image: imageId,
        command: ["node", "/app/plugins/browser/test/worker.mjs"],
        egressHosts: [],
        roomEgressAllowlist: true,
        pidsLimit: 256,
        maxOutputBytes: 256 * 1024,
      },
    });
    runner = new DockerToolRunner({
      registry,
      egressProxyContainer: proxyContainer,
      egressProxySecret: SECRET,
      timeoutMs: 45_000,
      roomEgressHosts: async (invocation) => {
        const { rows } = await db.pool.query<{ hosts: unknown }>(
          "SELECT settings -> 'egress_allowlist' AS hosts FROM rooms WHERE id = $1",
          [invocation.room_id],
        );
        return normalizeRoomEgressAllowlist(rows[0]?.hosts);
      },
    });
  }, 60_000);

  afterAll(async () => {
    await runner?.close();
    if (proxyContainer) {
      try {
        execFileSync("docker", ["rm", "--force", proxyContainer], {
          stdio: "ignore",
          timeout: 10_000,
        });
      } catch {
        // The test proxy may not have started; cleanup is idempotent.
      }
    }
    if (db) await db.drop();
  });

  it("uses the signed room allowlist, denies unsafe destinations, and caps UTF-8 page text", async () => {
    const navigate = await invoke("browser.navigate", { url: "https://browser-fixture.test/" });
    expect(navigate.result).toMatchObject({
      final_url: "https://browser-fixture.test/",
      status: 200,
      title: "Browser fixture",
      links: [{ text: "allowed link", href: "https://browser-fixture.test/next" }],
    });

    const page = await invoke("browser.read_page", { url: "https://browser-fixture.test/long" });
    const text = (page.result as { text: string; truncated: boolean }).text;
    expect(Buffer.byteLength(text, "utf8")).toBe(64 * 1024);
    expect(text).toBe("é".repeat(32_768));
    expect((page.result as { truncated: boolean }).truncated).toBe(true);

    await expect(
      invoke("browser.navigate", { url: "http://browser-fixture.test/" }),
    ).rejects.toMatchObject({
      options: { code: "VALIDATION", retryable: false },
    });

    for (const url of [
      "https://not-listed.test/",
      "https://browser-fixture.test/redirect",
      "https://127.0.0.1/",
      "https://169.254.169.254/",
    ]) {
      await expect(invoke("browser.navigate", { url })).rejects.toMatchObject({
        options: { code: "PROVIDER_UNAVAILABLE" },
      });
    }
  }, 60_000);

  async function invoke(tool: string, args: Record<string, unknown>) {
    const invocation: ToolInvocation = {
      tool,
      args,
      capability: "browser.navigate",
      scope: undefined,
      room_id: roomId,
      participant_id: participantId,
      invocation_id: newId("cmd"),
    };
    return runner!.run(invocation, new AbortController().signal);
  }
});

async function waitForProxy(container: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const logs = execFileSync("docker", ["logs", container], {
        encoding: "utf8",
        timeout: 2_000,
      });
      if (logs.includes("browser_test_proxy_started")) return;
    } catch {
      // Give the container a moment to load its DB connection and fixture listeners.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Browser test proxy did not start");
}
