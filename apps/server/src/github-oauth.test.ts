import { describe, expect, it, vi } from "vitest";
import { githubOAuthProvider } from "./github-oauth.js";

describe("GitHub OAuth provider", () => {
  it("uses PKCE and resolves the immutable numeric user id without retaining the token", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ access_token: "temporary-provider-token", token_type: "bearer" }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: 12345, login: "mutable-login", name: "Example User" }),
      );
    const provider = githubOAuthProvider(
      { clientId: "client-id", clientSecret: "client-secret" },
      fetch,
    );
    const authorization = new URL(
      provider.authorizationUrl({
        state: "state-value",
        challenge: "challenge-value",
        redirectUri: "https://app.example/v1/auth/oauth/github/callback",
      }),
    );
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(authorization.searchParams.get("scope")).toBe("read:user");

    const identity = await provider.identity({
      redirectUri: "https://app.example/v1/auth/oauth/github/callback",
      code: "one-time-code",
      verifier: "original-verifier",
    });
    expect(identity).toEqual({
      provider: "github",
      subject: "12345",
      display_name: "Example User",
    });
    const tokenRequest = fetch.mock.calls[0]?.[1];
    expect(String(tokenRequest?.body)).toContain("code_verifier=original-verifier");
    expect(String(tokenRequest?.body)).toContain("client_secret=client-secret");
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: "Bearer temporary-provider-token",
    });
    expect(JSON.stringify(identity)).not.toContain("temporary-provider-token");
  });

  it("rejects profiles without a numeric immutable ID", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "temporary" }))
      .mockResolvedValueOnce(Response.json({ id: "12345", login: "mutable-login" }));
    const provider = githubOAuthProvider({ clientId: "id", clientSecret: "secret" }, fetch);
    await expect(
      provider.identity({
        redirectUri: "https://app.example/callback",
        code: "code",
        verifier: "verifier",
      }),
    ).rejects.toThrow("GitHub identity could not be verified");
  });
});
