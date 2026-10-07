import { describe, expect, it } from "vitest";
import { createSandboxProxyCredential, verifySandboxProxyCredential } from "./proxy-credentials.js";

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
