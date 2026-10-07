import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { DockerExecutionDriver, DockerHealthRunner } from "@crossover/workspace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const IMAGE = "crossover-egress-proxy:test";
const SECRET = "0123456789abcdef0123456789abcdef";
const dockerImageAvailable = (() => {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore", timeout: 1_000 });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!dockerImageAvailable)("egress proxy Docker smoke", () => {
  let db: TestDatabase;
  let proxyName: string;
  let roomId: string;
  let healthRepository: string | undefined;
  let healthCacheVolume: string | undefined;
  let driver: DockerExecutionDriver;
  let sandboxId: string;
  let resources: { volume_ref: string; container_ref: string } | undefined;

  beforeAll(async () => {
    db = await createTestDatabase();
    proxyName = `crossover-egress-proxy-test-${process.pid}`;
    sandboxId = `sandbox_${randomBytes(12).toString("hex")}`;
    roomId = `room_${randomBytes(12).toString("hex")}`;
    const participantId = `part_${randomBytes(12).toString("hex")}`;
    const volumeRef = `crossover-sbx-${sandboxId.toLowerCase()}`;
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id, settings)
       VALUES ($1, $1, 'proxy Docker test', 'exercise sandbox proxy auth', $2, '{}')`,
      [roomId, participantId],
    );
    await db.pool.query(
      `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
       VALUES ($1, $2, 'HUMAN', 'Owner', 'OWNER', 'LEAD', 'ACTIVE')`,
      [participantId, roomId],
    );
    await db.pool.query(
      `INSERT INTO sandboxes (id, room_id, participant_id, status, volume_ref, container_ref)
       VALUES ($1, $2, $3, 'STARTING', $4, $4)`,
      [sandboxId, roomId, participantId, volumeRef],
    );

    const baseDatabaseUrl =
      process.env["DATABASE_URL"] ?? "postgres://crossover:crossover@localhost:5432/crossover";
    const proxyDatabaseUrl = new URL(baseDatabaseUrl);
    proxyDatabaseUrl.pathname = `/${db.name}`;
    if (["localhost", "127.0.0.1", "::1"].includes(proxyDatabaseUrl.hostname))
      proxyDatabaseUrl.hostname = "host.docker.internal";
    execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--restart",
        "unless-stopped",
        "--name",
        proxyName,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env",
        `DATABASE_URL=${proxyDatabaseUrl}`,
        "--env",
        `SANDBOX_EGRESS_PROXY_SECRET=${SECRET}`,
        "--env",
        "EGRESS_PROXY_HOST=0.0.0.0",
        "--env",
        "EGRESS_PROXY_PORT=3128",
        IMAGE,
      ],
      { stdio: "ignore", timeout: 20_000 },
    );
    driver = new DockerExecutionDriver({
      egressProxyContainer: proxyName,
      egressProxySecret: SECRET,
    });
    resources = await driver.create({
      sandbox_id: sandboxId,
      room_id: roomId,
      participant_id: participantId,
      limits: { disk_enforcement: "soft" },
    });
    await driver.start({ sandbox_id: sandboxId, resources });
  }, 60_000);

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    if (driver && sandboxId) {
      await driver
        .destroy({ sandbox_id: sandboxId, ...(resources ? { resources } : {}) })
        .catch((error: unknown) => cleanupErrors.push(error));
    }
    if (proxyName) {
      try {
        execFileSync("docker", ["rm", "--force", proxyName], { stdio: "ignore", timeout: 10_000 });
      } catch {
        // The proxy may not have started; cleanup remains idempotent.
      }
    }
    if (sandboxId) {
      try {
        execFileSync("docker", ["network", "rm", `crossover-net-${sandboxId.toLowerCase()}`], {
          stdio: "ignore",
          timeout: 10_000,
        });
      } catch {
        // The driver may already have removed the network.
      }
    }
    if (healthCacheVolume) {
      try {
        execFileSync("docker", ["volume", "rm", healthCacheVolume], {
          stdio: "ignore",
          timeout: 10_000,
        });
      } catch {
        // The runner may have failed before it created the cache volume.
      }
    }
    if (healthRepository)
      await rm(healthRepository, { recursive: true, force: true }).catch((error: unknown) =>
        cleanupErrors.push(error),
      );
    if (db) await db.drop().catch((error: unknown) => cleanupErrors.push(error));
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, "Docker smoke cleanup failed");
  });

  it("uses the authenticated per-sandbox proxy path and denies an unlisted HTTPS host", () => {
    const request = `const http=require('node:http');const p=new URL(process.env.HTTPS_PROXY);const headers={'Proxy-Authorization':'Basic '+Buffer.from(decodeURIComponent(p.username)+':'+decodeURIComponent(p.password)).toString('base64')};let attempts=0;function run(){const req=http.request({host:p.hostname,port:Number(p.port),method:'CONNECT',path:'example.com:443',headers});req.once('connect',(res,socket)=>{socket.destroy();if(res.statusCode===403)process.exit(0);if(res.statusCode===503&&attempts++<20)return setTimeout(run,100);process.exit(2)});req.once('error',()=>{if(attempts++<20)return setTimeout(run,100);process.exit(3)});req.end()}run();`;
    execFileSync("docker", ["exec", resources!.container_ref, "node", "-e", request], {
      stdio: "ignore",
      timeout: 10_000,
    });
    const logs = execFileSync("docker", ["logs", proxyName], { encoding: "utf8", timeout: 5_000 });
    expect(logs).toContain('"host":"example.com"');
    expect(logs).toContain('"allowed":false');
    expect(logs).not.toContain(SECRET);
  });

  it("refuses an unlisted install host and keeps the health command offline", async () => {
    healthRepository = await mkdtemp(join(tmpdir(), "crossover-health-proxy-smoke-"));
    execFileSync("git", ["init", "--quiet", healthRepository], { timeout: 10_000 });
    await writeFile(join(healthRepository, "package.json"), '{"name":"proxy-smoke"}\n');
    execFileSync("git", ["-C", healthRepository, "add", "package.json"], { timeout: 10_000 });
    execFileSync(
      "git",
      [
        "-C",
        healthRepository,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "health proxy smoke",
      ],
      { timeout: 10_000 },
    );
    const revision = execFileSync("git", ["-C", healthRepository, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    healthCacheVolume = `crossover-health-cache-${createHash("sha256")
      .update(roomId)
      .digest("hex")
      .slice(0, 24)}`;
    const runner = new DockerHealthRunner({
      image: IMAGE,
      allowedImages: [IMAGE],
      egressProxyContainer: proxyName,
      egressProxySecret: SECRET,
    });
    const installCommand = `node -e 'const p=new URL(process.env.HTTPS_PROXY);const headers={"Proxy-Authorization":"Basic "+Buffer.from(decodeURIComponent(p.username)+":"+decodeURIComponent(p.password)).toString("base64")};const req=require("node:http").request({host:p.hostname,port:Number(p.port),method:"CONNECT",path:"example.com:443",headers});req.once("connect",(response,socket)=>{socket.destroy();process.exit(response.statusCode===403?0:1)});req.once("error",()=>process.exit(2));req.setTimeout(5000,()=>{req.destroy();process.exit(3)});req.end();'`;
    const healthCommand = `node -e 'const socket=require("node:net").connect({host:"93.184.216.34",port:443});socket.setTimeout(1500);socket.once("connect",()=>process.exit(1));socket.once("error",()=>process.exit(0));socket.once("timeout",()=>process.exit(0));'`;

    const result = await runner.run({
      repository: healthRepository,
      revision,
      roomId,
      command: healthCommand,
      dependencyInstall: {
        pool: db.pool,
        command: installCommand,
        lockfilePaths: ["package-lock.json"],
      },
    });

    expect(result.status).toBe("GREEN");
    const logs = execFileSync("docker", ["logs", proxyName], { encoding: "utf8", timeout: 5_000 });
    expect(logs).toContain('"health_install_id":"hinstall_');
    expect(logs).toContain('"host":"example.com"');
    expect(logs).toContain('"allowed":false');
    expect(logs).not.toContain(SECRET);
  }, 60_000);
});
