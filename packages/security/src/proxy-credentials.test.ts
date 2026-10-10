import { describe, expect, it } from "vitest";
import {
  createPluginProxyCredential,
  createHealthInstallProxyCredential,
  createSandboxProxyCredential,
  verifyPluginProxyCredential,
  verifyHealthInstallProxyCredential,
  verifySandboxProxyCredential,
} from "./proxy-credentials.js";

describe("sandbox proxy credentials", () => {
  it("binds a credential to one sandbox and verifies it without exposing the secret", () => {
    const credential = createSandboxProxyCredential(
      "sandbox_01abc",
      "a-secret-with-32-chars-1234567890",
    );
    expect(
      verifySandboxProxyCredential(
        "sandbox_01abc",
        credential,
        "a-secret-with-32-chars-1234567890",
      ),
    ).toBe(true);
    expect(
      verifySandboxProxyCredential(
        "sandbox_01other",
        credential,
        "a-secret-with-32-chars-1234567890",
      ),
    ).toBe(false);
    expect(
      verifySandboxProxyCredential("sandbox_01abc", credential, "different-secret-32-chars-123456"),
    ).toBe(false);
    expect(credential).not.toContain("a-secret-with-32-chars-1234567890");
  });

  it("rejects malformed signatures", () => {
    expect(verifySandboxProxyCredential("sandbox_01abc", "bad", "secret")).toBe(false);
  });
});

describe("health install proxy credentials", () => {
  it("binds a credential to one install run and separates it from sandbox credentials", () => {
    const installId = "hinstall_01J8D9M8T2B7K4V5W6X3Y2Z1AB";
    const secret = "a-secret-with-32-chars-1234567890";
    const credential = createHealthInstallProxyCredential(installId, secret);

    expect(verifyHealthInstallProxyCredential(installId, credential, secret)).toBe(true);
    expect(verifyHealthInstallProxyCredential(`${installId}x`, credential, secret)).toBe(false);
    expect(verifyHealthInstallProxyCredential(installId, "bad", secret)).toBe(false);
    expect(verifySandboxProxyCredential(installId, credential, secret)).toBe(false);
    expect(credential).not.toContain(secret);
  });
});

describe("plugin proxy credentials", () => {
  it("signs one invocation's short-lived host scope and rejects tampering or expiry", () => {
    const secret = "a-secret-with-32-chars-1234567890";
    const now = Date.now();
    const claims = {
      invocationId: "cmd_01J8D9M8T2B7K4V5W6X3Y2Z1AB",
      roomId: "room_01J8D9M8T2B7K4V5W6X3Y2Z1AB",
      participantId: "part_01J8D9M8T2B7K4V5W6X3Y2Z1AB",
      hosts: ["api.github.com"],
      expiresAt: now + 10_000,
    };
    const credential = createPluginProxyCredential(claims, secret);

    expect(verifyPluginProxyCredential(credential, secret, now)).toEqual(claims);
    expect(verifyPluginProxyCredential(credential, secret, claims.expiresAt)).toBeNull();
    expect(
      verifyPluginProxyCredential(credential, "different-secret-32-chars-123456", now),
    ).toBeNull();
    const [payload, signature] = credential.split(".");
    const altered = Buffer.from(
      JSON.stringify({ ...claims, hosts: ["attacker.example"] }),
    ).toString("base64url");
    expect(verifyPluginProxyCredential(`${altered}.${signature}`, secret, now)).toBeNull();
    expect(verifyPluginProxyCredential(`${payload}.bad`, secret, now)).toBeNull();
  });

  it("allows an empty host scope and rejects noncanonical or oversized lists", () => {
    const secret = "a-secret-with-32-chars-1234567890";
    const base = {
      invocationId: "cmd_1",
      roomId: "room_1",
      participantId: "part_1",
      hosts: [] as string[],
      expiresAt: Date.now() + 1_000,
    };
    const noEgress = createPluginProxyCredential(base, secret);
    expect(verifyPluginProxyCredential(noEgress, secret)?.hosts).toEqual([]);
    expect(() =>
      createPluginProxyCredential({ ...base, hosts: ["z.example.com", "a.example.com"] }, secret),
    ).toThrow(/claims are invalid/);
    expect(() =>
      createPluginProxyCredential(
        {
          ...base,
          hosts: Array.from({ length: 16 }, (_, index) => {
            const first = `h${index}`.padEnd(63, "a");
            return `${first}.${"b".repeat(63)}.${"c".repeat(61)}.${"d".repeat(63)}`;
          }),
        },
        secret,
      ),
    ).toThrow(/claims are invalid/);
  });

  it("rejects invalid or overlong claims before they become proxy credentials", () => {
    const base = {
      invocationId: "cmd_1",
      roomId: "room_1",
      participantId: "part_1",
      hosts: ["api.github.com"],
      expiresAt: Date.now() + 1_000,
    };
    const secret = "a-secret-with-32-chars-1234567890";
    expect(() =>
      createPluginProxyCredential({ ...base, hosts: ["x".repeat(254)] }, secret),
    ).toThrow(/claims are invalid/);
    expect(() =>
      createPluginProxyCredential({ ...base, expiresAt: Date.now() + 6 * 60_000 }, secret),
    ).toThrow(/claims are invalid/);
  });
});
