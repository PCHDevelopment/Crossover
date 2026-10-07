import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      sandboxId: fixture.sandboxId,
      roomId: fixture.roomId,
      host: "registry.npmjs.org",
      address: "93.184.216.34",
      port: 443,
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
