import type { OAuthProvider } from "@crossover/gateway";

type GitHubOAuthConfig = { clientId: string; clientSecret: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function githubOAuthProvider(
  config: GitHubOAuthConfig,
  fetchImpl: typeof fetch = fetch,
): OAuthProvider {
  const request = async (url: string, init: RequestInit): Promise<Record<string, unknown>> => {
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isRecord(body)) throw new Error();
      return body;
    } catch {
      throw new Error("GitHub OAuth provider request failed");
    }
  };

  return {
    name: "github",
    authorizationUrl(input) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: input.redirectUri,
        scope: "read:user",
        state: input.state,
        code_challenge: input.challenge,
        code_challenge_method: "S256",
      }).toString();
      return url.toString();
    },
    async identity(input) {
      const tokenBody = await request("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.verifier,
        }),
      });
      if (typeof tokenBody.access_token !== "string")
        throw new Error("GitHub OAuth code was rejected");

      const profile = await request("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${tokenBody.access_token}`,
          "x-github-api-version": "2022-11-28",
        },
      });
      if (typeof profile.id !== "number" || !Number.isSafeInteger(profile.id) || profile.id <= 0) {
        throw new Error("GitHub identity could not be verified");
      }
      const name = [profile.name, profile.login].find(
        (value) => typeof value === "string" && value.trim(),
      );
      return {
        provider: "github",
        subject: String(profile.id),
        display_name: typeof name === "string" ? name.trim() : "GitHub user",
      };
    },
  };
}
