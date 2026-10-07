import { describe, expect, it } from "vitest";
import {
  createHealthInstallProxyCredential,
  createSandboxProxyCredential,
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
