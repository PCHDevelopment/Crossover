import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHealthInstallProxyCredential,
  createSandboxProxyCredential,
} from "@crossover/security";
import { proxyAuthorization } from "./test-fixtures/auth.js";
import { createProxyTestFixture, type ProxyTestFixture } from "./test-fixtures/database.js";
import { authorizeConnect } from "./policy.js";

const SECRET = "0123456789abcdef0123456789abcdef";
let fixture: ProxyTestFixture;

beforeAll(async () => {
  fixture = await createProxyTestFixture();
}, 60_000);

afterAll(async () => {
  if (fixture) await fixture.db.drop();
});

describe("egress policy", () => {
  it("maps an authenticated sandbox to its active room and pins a default host to a public IP", async () => {
    const result = await authorizeConnect("registry.npmjs.org:443", auth(), {
      pool: fixture.db.pool,
      secret: SECRET,
      resolveHost: async (host) => {
        expect(host).toBe("registry.npmjs.org");
        return ["93.184.216.34"];
      },
    });
    expect(result).toEqual({
      allowed: true,
      identityId: fixture.sandboxId,
      identityType: "sandbox",
      sandboxId: fixture.sandboxId,
      roomId: fixture.roomId,
      host: "registry.npmjs.org",
      addresses: ["93.184.216.34"],
      port: 443,
    });
  });

  it("authorizes a live health install only while its run and room are active", async () => {
    const installId = "hinstall_01J8D9M8T2B7K4V5W6X3Y2Z1AC";
    await fixture.db.pool.query(
      `INSERT INTO health_install_runs (id, room_id, cache_key, status, expires_at)
       VALUES ($1, $2, $3, 'RUNNING', clock_timestamp() + interval '5 minutes')`,
      [installId, fixture.roomId, "a".repeat(64)],
    );
    const authorization = healthInstallAuth(installId);
    const options = {
      pool: fixture.db.pool,
      secret: SECRET,
      resolveHost: async () => ["93.184.216.34"],
    };

    await expect(
      authorizeConnect("registry.npmjs.org:443", authorization, options),
    ).resolves.toEqual({
      allowed: true,
      identityId: installId,
      identityType: "health_install",
      healthInstallId: installId,
      roomId: fixture.roomId,
      host: "registry.npmjs.org",
      addresses: ["93.184.216.34"],
      port: 443,
    });
    await expect(
      authorizeConnect("example.com:443", authorization, options),
    ).resolves.toMatchObject({
      allowed: false,
      status: 403,
      healthInstallId: installId,
      reason: "host_not_allowlisted",
    });
    const sandboxCredential = createSandboxProxyCredential(installId, SECRET);
    const sandboxAuthorization = `Basic ${Buffer.from(`${installId}:${sandboxCredential}`).toString("base64")}`;
    await expect(
      authorizeConnect("registry.npmjs.org:443", sandboxAuthorization, options),
    ).resolves.toMatchObject({ allowed: false, status: 407 });

    await fixture.db.pool.query("UPDATE rooms SET status = 'PAUSED' WHERE id = $1", [
      fixture.roomId,
    ]);
    try {
      await expect(
        authorizeConnect("registry.npmjs.org:443", authorization, options),
      ).resolves.toMatchObject({
        allowed: false,
        status: 403,
        reason: "health_install_inactive",
      });
    } finally {
      await fixture.db.pool.query("UPDATE rooms SET status = 'ACTIVE' WHERE id = $1", [
        fixture.roomId,
      ]);
    }

    await fixture.db.pool.query(
      "UPDATE health_install_runs SET status = 'SUCCEEDED', finished_at = clock_timestamp() WHERE id = $1",
      [installId],
    );
    await expect(
      authorizeConnect("registry.npmjs.org:443", authorization, options),
    ).resolves.toMatchObject({
      allowed: false,
      status: 403,
      healthInstallId: installId,
      reason: "health_install_inactive",
    });
  });

  it("rejects expired health install credentials", async () => {
    const installId = "hinstall_01J8D9M8T2B7K4V5W6X3Y2Z1AD";
    await fixture.db.pool.query(
      `INSERT INTO health_install_runs (id, room_id, cache_key, status, started_at, expires_at)
       VALUES ($1, $2, $3, 'RUNNING', clock_timestamp() - interval '2 minutes',
               clock_timestamp() - interval '1 second')`,
      [installId, fixture.roomId, "b".repeat(64)],
    );

    await expect(
      authorizeConnect("registry.npmjs.org:443", healthInstallAuth(installId), {
        pool: fixture.db.pool,
        secret: SECRET,
      }),
    ).resolves.toMatchObject({
      allowed: false,
      status: 403,
      healthInstallId: installId,
      reason: "health_install_inactive",
    });
  });

  it("rejects invalid credentials, inactive participants, and hosts outside the room policy", async () => {
    await expect(
      authorizeConnect("registry.npmjs.org:443", auth("wrong-secret-with-32-characters"), {
        pool: fixture.db.pool,
        secret: SECRET,
      }),
    ).resolves.toMatchObject({ allowed: false, status: 407, reason: "invalid_proxy_credential" });
    await expect(
      authorizeConnect("example.com:443", auth(), { pool: fixture.db.pool, secret: SECRET }),
    ).resolves.toMatchObject({ allowed: false, status: 403, reason: "host_not_allowlisted" });

    await fixture.db.pool.query("UPDATE participants SET status = 'PAUSED' WHERE id = $1", [
      fixture.participantId,
    ]);
    try {
      await expect(
        authorizeConnect("registry.npmjs.org:443", auth(), {
          pool: fixture.db.pool,
          secret: SECRET,
        }),
      ).resolves.toMatchObject({ allowed: false, status: 403, reason: "sandbox_inactive" });
    } finally {
      await fixture.db.pool.query("UPDATE participants SET status = 'ACTIVE' WHERE id = $1", [
        fixture.participantId,
      ]);
    }
  });

  it("blocks private and mapped-private DNS answers for room-allowlisted hosts", async () => {
    for (const address of ["169.254.169.254", "::ffff:a9fe:a9fe"]) {
      await expect(
        authorizeConnect("private.allowed.example:443", auth(), {
          pool: fixture.db.pool,
          secret: SECRET,
          resolveHost: async () => [address],
        }),
      ).resolves.toMatchObject({
        allowed: false,
        status: 403,
        reason: "unsafe_or_unresolved_address",
      });
    }
  });

  it("fails closed for malformed targets and DNS failures", async () => {
    for (const authority of ["", "127.0.0.1:443", "registry.npmjs.org:80"]) {
      await expect(
        authorizeConnect(authority, auth(), { pool: fixture.db.pool, secret: SECRET }),
      ).resolves.toMatchObject({ allowed: false, status: 400 });
    }
    await expect(
      authorizeConnect("registry.npmjs.org:443", auth(), {
        pool: fixture.db.pool,
        secret: SECRET,
        resolveHost: async () => [],
      }),
    ).resolves.toMatchObject({ allowed: false, reason: "unsafe_or_unresolved_address" });
  });
});

function auth(secret = SECRET): string {
  return proxyAuthorization(fixture.sandboxId, secret);
}

function healthInstallAuth(installId: string): string {
  const credential = createHealthInstallProxyCredential(installId, SECRET);
  return `Basic ${Buffer.from(`${installId}:${credential}`).toString("base64")}`;
}
