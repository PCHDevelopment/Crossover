// Moved from server.ts (T1568) without changing route behavior.
import type { Pool } from "@crossover/db";
import { randomBytes } from "node:crypto";
import { authenticateUser, type GitHubPendingRepository } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayOptions } from "./server.js";
import { GITHUB_INSTALL_STATE_TTL_MS, GITHUB_PENDING_CONNECTION_TTL_MS } from "./github-install.js";
import {
  GITHUB_INSTALL_STATE_COOKIE_PREFIX,
  SECURE_GITHUB_INSTALL_STATE_COOKIE_PREFIX,
  OAUTH_STATE,
  cookieValue,
  clearCookie,
  userToken,
  requireSameOriginNavigation,
} from "./cookies.js";

async function githubOwnerForUser(
  pool: Pool,
  roomId: string,
  userId: string,
  expectedParticipantId?: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<{ participant_id: string }>(
    `SELECT p.id AS participant_id
     FROM participants p
     WHERE p.room_id = $1 AND p.user_id = $2 AND p.kind = 'HUMAN'
       AND p.authority = 'OWNER' AND p.status = 'ACTIVE'
       AND ($3::text IS NULL OR p.id = $3)`,
    [roomId, userId, expectedParticipantId ?? null],
  );
  return rows[0]?.participant_id;
}

export function registerGitHubInstallRoutes(
  app: FastifyInstance,
  deps: {
    pool: Pool;
    githubAppInstall: NonNullable<GatewayOptions["githubAppInstall"]>;
    secureCookies: boolean;
    sessionCookieName: string;
    cookieAuthEnabled: boolean;
    publicBaseUrl: string | undefined;
    humanUser: (request: FastifyRequest) => Promise<{
      principal: Awaited<ReturnType<typeof authenticateUser>>;
      token: string;
      cookie: boolean;
    }>;
  },
): void {
  const {
    pool,
    githubAppInstall,
    secureCookies,
    sessionCookieName,
    cookieAuthEnabled,
    publicBaseUrl,
    humanUser,
  } = deps;
  const install = githubAppInstall;
  const installStateCookiePrefix = secureCookies
    ? SECURE_GITHUB_INSTALL_STATE_COOKIE_PREFIX
    : GITHUB_INSTALL_STATE_COOKIE_PREFIX;
  const installCallbackPath = "/v1/auth/github-app/callback";
  const failedLocation = (reason: "access_denied" | "unavailable" | "invalid") =>
    `/?github_install=failed&github_install_reason=${reason}`;
  const clearInstallStateCookie = (state: string) =>
    clearCookie(`${installStateCookiePrefix}${state}`, secureCookies);

  app.get<{ Params: { roomId: string } }>(
    "/v1/rooms/:roomId/integrations/github/install",
    async (request, reply) => {
      const auth = userToken(request, cookieAuthEnabled, sessionCookieName);
      if (auth.cookie) requireSameOriginNavigation(request, publicBaseUrl);
      const principal = await authenticateUser(pool, auth.token);
      const ownerParticipantId = await githubOwnerForUser(
        pool,
        request.params.roomId,
        principal.user_id,
      );
      if (!ownerParticipantId)
        throw new CrossoverError("FORBIDDEN", "Only the room owner can manage integrations", {
          details: { reason: "owner_only" },
        });

      const state = randomBytes(32).toString("base64url");
      await install.stateStore.saveState(state, {
        room_id: request.params.roomId,
        owner_participant_id: ownerParticipantId,
      });
      const destination = new URL(
        `https://github.com/apps/${encodeURIComponent(install.slug)}/installations/new`,
      );
      destination.searchParams.set("state", state);
      const cookie = `${installStateCookiePrefix}${state}=1; Path=/; Max-Age=${GITHUB_INSTALL_STATE_TTL_MS / 1000}; HttpOnly; SameSite=Lax${secureCookies ? "; Secure" : ""}`;
      return reply
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("Set-Cookie", cookie)
        .redirect(destination.toString());
    },
  );

  app.get<{
    Params: { roomId: string };
    Querystring: { pending_id?: string };
  }>("/v1/rooms/:roomId/integrations/github/pending", async (request, reply) => {
    const auth = userToken(request, cookieAuthEnabled, sessionCookieName);
    if (auth.cookie) requireSameOriginNavigation(request, publicBaseUrl);
    const principal = await authenticateUser(pool, auth.token);
    const ownerParticipantId = await githubOwnerForUser(
      pool,
      request.params.roomId,
      principal.user_id,
    );
    if (!ownerParticipantId)
      throw new CrossoverError("FORBIDDEN", "Only the room owner can manage integrations", {
        details: { reason: "owner_only" },
      });
    const pendingId = request.query.pending_id;
    if (typeof pendingId !== "string" || !OAUTH_STATE.test(pendingId)) {
      throw new CrossoverError("VALIDATION", "Invalid GitHub pending connection");
    }
    let pending: Awaited<ReturnType<typeof install.pendingConnections.peek>>;
    try {
      pending = await install.pendingConnections.peek(pendingId, {
        room_id: request.params.roomId,
        owner_participant_id: ownerParticipantId,
      });
    } catch {
      throw new CrossoverError("PROVIDER_UNAVAILABLE", "GitHub integration is unavailable");
    }
    if (!pending) throw new CrossoverError("NOT_FOUND", "GitHub pending connection not found");
    return reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .send({ repositories: pending.repositories.map(({ name }) => ({ name })) });
  });

  app.get<{
    Querystring: { state?: string; code?: string; installation_id?: string; error?: string };
  }>(installCallbackPath, async (request, reply) => {
    const { state, code, installation_id: installationId, error } = request.query;
    const failed = (reason: "access_denied" | "unavailable" | "invalid", clearState?: string) => {
      const response = reply
        .status(303)
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer");
      if (clearState) response.header("Set-Cookie", clearState);
      return response.header("Location", failedLocation(reason)).send();
    };
    if (
      typeof state !== "string" ||
      !OAUTH_STATE.test(state) ||
      cookieValue(request, `${installStateCookiePrefix}${state}`) !== "1"
    ) {
      return failed("invalid");
    }
    let transaction: { room_id: string; owner_participant_id: string } | undefined;
    try {
      transaction = await install.stateStore.consumeState(state);
    } catch {
      return failed("unavailable", clearInstallStateCookie(state));
    }
    const clearState = clearInstallStateCookie(state);
    if (!transaction) return failed("invalid", clearState);
    if (error !== undefined)
      return failed(error === "access_denied" ? "access_denied" : "unavailable", clearState);
    if (
      typeof code !== "string" ||
      !code ||
      code.length > 2048 ||
      typeof installationId !== "string" ||
      !/^[1-9]\d{0,15}$/.test(installationId) ||
      !Number.isSafeInteger(Number(installationId))
    ) {
      return failed("invalid", clearState);
    }

    let principal: Awaited<ReturnType<typeof authenticateUser>>;
    try {
      ({ principal } = await humanUser(request));
    } catch (authError) {
      return failed(
        authError instanceof CrossoverError && authError.code === "UNAUTHENTICATED"
          ? "invalid"
          : "unavailable",
        clearState,
      );
    }

    let ownerParticipantId: string | undefined;
    try {
      ownerParticipantId = await githubOwnerForUser(
        pool,
        transaction.room_id,
        principal.user_id,
        transaction.owner_participant_id,
      );
    } catch {
      return failed("unavailable", clearState);
    }
    if (!ownerParticipantId) return failed("invalid", clearState);

    let repositories: readonly GitHubPendingRepository[];
    try {
      repositories = await install.authorizeInstallation({
        installation_id: Number(installationId),
        code,
      });
    } catch {
      return failed("unavailable", clearState);
    }
    if (!repositories.length) return failed("invalid", clearState);

    try {
      const pendingId = randomBytes(32).toString("base64url");
      await install.pendingConnections.save(pendingId, {
        room_id: transaction.room_id,
        owner_participant_id: ownerParticipantId,
        installation_id: installationId,
        repositories,
        expires_at: new Date(Date.now() + GITHUB_PENDING_CONNECTION_TTL_MS).toISOString(),
      });
      const destination = `/rooms/${encodeURIComponent(transaction.room_id)}#github_pending=${pendingId}`;
      return reply
        .status(303)
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("Set-Cookie", clearState)
        .header("Location", destination)
        .send();
    } catch {
      return failed("unavailable", clearState);
    }
  });
}
