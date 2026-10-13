import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { OAuthProvider } from "@crossover/gateway";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
// Published in Google's OpenID Connect discovery document.
const GOOGLE_JWKS_URI = new URL("https://www.googleapis.com/oauth2/v3/certs");
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_ID_TOKEN_AGE_SECONDS = 10 * 60;

type GoogleOAuthConfig = { clientId: string; clientSecret: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Google sign-in using authorization code + PKCE and locally verified OIDC ID tokens. */
export function googleOAuthProvider(
  config: GoogleOAuthConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): OAuthProvider {
  const jwks = createRemoteJWKSet(GOOGLE_JWKS_URI, {
    timeoutDuration: 5_000,
    [customFetch]: (input, init) => fetchImpl(input, init),
  });

  const requestToken = async (input: {
    code: string;
    redirectUri: string;
    verifier: string;
  }): Promise<string> => {
    try {
      const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code: input.code,
          code_verifier: input.verifier,
          grant_type: "authorization_code",
          redirect_uri: input.redirectUri,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok || !isRecord(body) || typeof body.id_token !== "string") throw new Error();
      return body.id_token;
    } catch {
      throw new Error("Google OAuth code exchange failed");
    }
  };

  return {
    name: "google",
    authorizationUrl(input) {
      if (!input.nonce) throw new Error("Google OAuth nonce is missing");
      const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        code_challenge: input.challenge,
        code_challenge_method: "S256",
        nonce: input.nonce,
        redirect_uri: input.redirectUri,
        response_type: "code",
        scope: "openid profile",
        state: input.state,
      }).toString();
      return url.toString();
    },
    async identity(input) {
      if (!input.nonce) throw new Error("Google OAuth nonce is missing");
      const idToken = await requestToken(input);
      let payload;
      try {
        ({ payload } = await jwtVerify(idToken, jwks, {
          algorithms: ["RS256"],
          audience: config.clientId,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          currentDate: now(),
          issuer: GOOGLE_ISSUERS,
          maxTokenAge: MAX_ID_TOKEN_AGE_SECONDS,
          requiredClaims: ["exp", "nonce"],
        }));
      } catch {
        throw new Error("Google identity could not be verified");
      }

      if (payload.nonce !== input.nonce) throw new Error("Google identity could not be verified");
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) {
        throw new Error("Google identity could not be verified");
      }
      if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255) {
        throw new Error("Google identity could not be verified");
      }

      const name = payload.name;
      return {
        provider: "google",
        subject: payload.sub,
        display_name:
          typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : "Google user",
      };
    },
  };
}
