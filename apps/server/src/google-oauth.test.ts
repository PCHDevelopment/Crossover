import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { googleOAuthProvider } from "./google-oauth.js";

const CLIENT_ID = "google-client.apps.googleusercontent.com";
const CLIENT_SECRET = "google-client-secret";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
const REDIRECT_URI = "https://crossover.example.com/v1/auth/oauth/google/callback";
const NONCE = "transaction-nonce";
const NOW = new Date("2026-10-12T23:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const MAX_ID_TOKEN_AGE_SECONDS = 10 * 60;
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let privateKey: SigningKey;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    alg: "RS256",
    kid: "google-test-key",
    use: "sig",
  };
});

function payload(
  overrides: Record<string, unknown> = {},
  options: { iat?: number; exp?: number } = {},
) {
  return {
    aud: CLIENT_ID,
    exp: options.exp ?? NOW_SECONDS + 300,
    iat: options.iat ?? NOW_SECONDS,
    iss: "https://accounts.google.com",
    name: "Google User",
    nonce: NONCE,
    sub: "109876543210987654321",
    ...overrides,
  };
}

async function signToken(
  claims = payload(),
  key: SigningKey = privateKey,
  alg: "RS256" | "HS256" = "RS256",
): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg, kid: "google-test-key" }).sign(key);
}

function stubFetch(idToken: string, keys: Record<string, unknown>[] = [publicJwk]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url === TOKEN_ENDPOINT) {
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === JWKS_URI) {
      return new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  return { fetchImpl, calls };
}

const exchange = (nonce = NONCE) => ({
  code: "one-time-code",
  redirectUri: REDIRECT_URI,
  verifier: "pkce-verifier",
  nonce,
});

function providerWithToken(idToken: string, keys?: Record<string, unknown>[]) {
  const { fetchImpl, calls } = stubFetch(idToken, keys);
  return {
    provider: googleOAuthProvider(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      fetchImpl,
      () => NOW,
    ),
    calls,
  };
}

describe("Google OAuth provider", () => {
  it("requests only OpenID profile claims with state, nonce, and S256 PKCE", () => {
    const provider = googleOAuthProvider({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const url = new URL(
      provider.authorizationUrl({
        state: "state-value",
        challenge: "pkce-challenge",
        redirectUri: REDIRECT_URI,
        nonce: NONCE,
      }),
    );

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("nonce")).toBe(NONCE);
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  it.each(["https://accounts.google.com", "accounts.google.com"])(
    "exchanges a code and accepts Google's exact issuer %s",
    async (issuer) => {
      const token = await signToken(payload({ iss: issuer }));
      const { provider, calls } = providerWithToken(token);

      await expect(provider.identity(exchange())).resolves.toEqual({
        provider: "google",
        subject: "109876543210987654321",
        display_name: "Google User",
      });
      expect(calls.map((call) => call.url)).toEqual([TOKEN_ENDPOINT, JWKS_URI]);
      const tokenRequest = calls[0]!.init!;
      expect(tokenRequest.method).toBe("POST");
      expect(tokenRequest.signal).toBeDefined();
      expect(new URLSearchParams(String(tokenRequest.body))).toEqual(
        new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code: "one-time-code",
          code_verifier: "pkce-verifier",
          grant_type: "authorization_code",
          redirect_uri: REDIRECT_URI,
        }),
      );
    },
  );

  it("uses sub as the identity key and falls back when name is absent", async () => {
    const token = await signToken(payload({ name: "  " }));
    const { provider } = providerWithToken(token);

    await expect(provider.identity(exchange())).resolves.toEqual({
      provider: "google",
      subject: "109876543210987654321",
      display_name: "Google user",
    });
  });

  it("reuses jose's cached JWKS for subsequent sign-ins", async () => {
    const token = await signToken();
    const { provider, calls } = providerWithToken(token);

    await provider.identity(exchange());
    await provider.identity(exchange());

    expect(calls.filter((call) => call.url === JWKS_URI)).toHaveLength(1);
  });

  it.each([
    ["issuer", { iss: "https://accounts.google.com.attacker.example" }],
    ["audience", { aud: "another-client.apps.googleusercontent.com" }],
    ["nonce", { nonce: "attacker-nonce" }],
    ["subject", { sub: "" }],
    ["missing subject", { sub: undefined }],
  ])("rejects a token with an invalid %s", async (_name, overrides) => {
    const token = await signToken(payload(overrides));
    const { provider } = providerWithToken(token);

    await expect(provider.identity(exchange())).rejects.toThrow(
      "Google identity could not be verified",
    );
  });

  it("requires azp to match the client when aud contains multiple values", async () => {
    const valid = await signToken(payload({ aud: [CLIENT_ID, "another-client"], azp: CLIENT_ID }));
    const { provider: validProvider } = providerWithToken(valid);
    await expect(validProvider.identity(exchange())).resolves.toMatchObject({
      subject: "109876543210987654321",
    });

    const invalid = await signToken(payload({ aud: [CLIENT_ID, "another-client"] }));
    const { provider: invalidProvider } = providerWithToken(invalid);
    await expect(invalidProvider.identity(exchange())).rejects.toThrow(
      "Google identity could not be verified",
    );
  });

  it("allows at most 60 seconds of exp and iat clock skew", async () => {
    const validExpiry = await signToken(payload({}, { exp: NOW_SECONDS - 59 }));
    const { provider: validExpiryProvider } = providerWithToken(validExpiry);
    await expect(validExpiryProvider.identity(exchange())).resolves.toMatchObject({
      subject: "109876543210987654321",
    });

    const expiredAtBoundary = await signToken(payload({}, { exp: NOW_SECONDS - 60 }));
    const { provider: expiredProvider } = providerWithToken(expiredAtBoundary);
    await expect(expiredProvider.identity(exchange())).rejects.toThrow(
      "Google identity could not be verified",
    );

    const iatAtAgeBoundary = await signToken(
      payload({}, { iat: NOW_SECONDS - MAX_ID_TOKEN_AGE_SECONDS - 60 }),
    );
    const { provider: ageBoundaryProvider } = providerWithToken(iatAtAgeBoundary);
    await expect(ageBoundaryProvider.identity(exchange())).resolves.toMatchObject({
      subject: "109876543210987654321",
    });

    const iatPastBoundary = await signToken(
      payload({}, { iat: NOW_SECONDS - MAX_ID_TOKEN_AGE_SECONDS - 61 }),
    );
    const { provider: oldProvider } = providerWithToken(iatPastBoundary);
    await expect(oldProvider.identity(exchange())).rejects.toThrow(
      "Google identity could not be verified",
    );

    const iatFutureBoundary = await signToken(payload({}, { iat: NOW_SECONDS + 60 }));
    const { provider: futureBoundaryProvider } = providerWithToken(iatFutureBoundary);
    await expect(futureBoundaryProvider.identity(exchange())).resolves.toMatchObject({
      subject: "109876543210987654321",
    });

    const iatTooFarFuture = await signToken(payload({}, { iat: NOW_SECONDS + 61 }));
    const { provider: futureProvider } = providerWithToken(iatTooFarFuture);
    await expect(futureProvider.identity(exchange())).rejects.toThrow(
      "Google identity could not be verified",
    );
  });

  it("rejects invalid signatures and every algorithm except RS256", async () => {
    const otherPair = await generateKeyPair("RS256", { modulusLength: 2048 });
    const wrongSignature = await signToken(payload(), otherPair.privateKey);
    const { provider: wrongKeyProvider } = providerWithToken(wrongSignature);
    await expect(wrongKeyProvider.identity(exchange())).rejects.toThrow(
      "Google identity could not be verified",
    );

    const hmacToken = await new SignJWT(payload())
      .setProtectedHeader({ alg: "HS256", kid: "google-test-key" })
      .sign(new TextEncoder().encode("not-a-google-key"));
    const { provider: hmacProvider } = providerWithToken(hmacToken);
    await expect(hmacProvider.identity(exchange())).rejects.toThrow(
      "Google identity could not be verified",
    );

    const unsignedToken = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload())).toString("base64url")}.`;
    const { provider: unsignedProvider } = providerWithToken(unsignedToken);
    await expect(unsignedProvider.identity(exchange())).rejects.toThrow(
      "Google identity could not be verified",
    );
  });

  it("does not continue when the token endpoint fails", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () =>
        new Response("{}", { status: 503, headers: { "content-type": "application/json" } }),
    );
    const provider = googleOAuthProvider(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      fetchImpl,
    );

    await expect(provider.identity(exchange())).rejects.toThrow(
      "Google OAuth code exchange failed",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not continue when Google's JWKS cannot be fetched", async () => {
    const token = await signToken();
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input) === TOKEN_ENDPOINT) {
        return new Response(JSON.stringify({ id_token: token }), { status: 200 });
      }
      throw new Error("network unavailable");
    };
    const provider = googleOAuthProvider(
      { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      fetchImpl,
      () => NOW,
    );

    await expect(provider.identity(exchange())).rejects.toThrow(
      "Google identity could not be verified",
    );
  });
});
