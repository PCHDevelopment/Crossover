import { isIP } from "node:net";
import type { Pool } from "@crossover/db";
import {
  resolvePublicAddresses,
  verifySandboxProxyCredential,
  type HostResolver,
} from "@crossover/security";
import {
  isAllowedEgressHost,
  normalizeEgressHost,
  normalizeRoomEgressAllowlist,
} from "./allowlist.js";

const ACTIVE_SANDBOX_SQL = `
  SELECT s.room_id, r.settings
  FROM sandboxes s
  JOIN rooms r ON r.id = s.room_id
  JOIN participants p ON p.id = s.participant_id AND p.room_id = s.room_id
  WHERE s.id = $1
    AND s.status NOT IN ('DESTROYING', 'DESTROYED')
    AND r.status = 'ACTIVE'
    AND p.status = 'ACTIVE'
`;

export interface EgressPolicyOptions {
  pool: Pool;
  secret: string;
  resolveHost?: HostResolver;
}

export type ConnectPolicy =
  | {
      allowed: true;
      sandboxId: string;
      roomId: string;
      host: string;
      address: string;
      port: 443;
    }
  | {
      allowed: false;
      status: number;
      sandboxId?: string;
      roomId?: string;
      host: string;
      reason: string;
    };

interface ActiveSandbox {
  room_id: string;
  settings: unknown;
}

interface ConnectTarget {
  host: string;
  port: 443;
}

interface ProxyIdentity {
  sandboxId: string;
  credential: string;
}

/** Authenticate a CONNECT request, load its room policy, and return a pinned public address. */
export async function authorizeConnect(
  authority: string,
  authorization: string | string[] | undefined,
  options: EgressPolicyOptions,
): Promise<ConnectPolicy> {
  let target: ConnectTarget;
  try {
    target = parseConnectTarget(authority);
  } catch {
    return {
      allowed: false,
      status: 400,
      host: "<invalid>",
      reason: "invalid_connect_target",
    };
  }

  const identity = parseProxyIdentity(authorization);
  if (
    !identity ||
    !verifySandboxProxyCredential(identity.sandboxId, identity.credential, options.secret)
  ) {
    return {
      allowed: false,
      status: 407,
      host: target.host,
      reason: "invalid_proxy_credential",
    };
  }

  let sandbox: ActiveSandbox | undefined;
  try {
    const { rows } = await options.pool.query<ActiveSandbox>(ACTIVE_SANDBOX_SQL, [
      identity.sandboxId,
    ]);
    sandbox = rows[0];
  } catch {
    return {
      allowed: false,
      status: 503,
      sandboxId: identity.sandboxId,
      host: target.host,
      reason: "policy_unavailable",
    };
  }
  if (!sandbox) {
    return {
      allowed: false,
      status: 403,
      sandboxId: identity.sandboxId,
      host: target.host,
      reason: "sandbox_inactive",
    };
  }

  let roomAllowlist: string[];
  try {
    const settings = sandbox.settings;
    const roomSettings =
      settings && typeof settings === "object" && !Array.isArray(settings)
        ? (settings as Record<string, unknown>)
        : {};
    roomAllowlist = normalizeRoomEgressAllowlist(roomSettings.egress_allowlist);
  } catch {
    return {
      allowed: false,
      status: 403,
      sandboxId: identity.sandboxId,
      roomId: sandbox.room_id,
      host: target.host,
      reason: "invalid_room_allowlist",
    };
  }
  if (!isAllowedEgressHost(target.host, roomAllowlist)) {
    return {
      allowed: false,
      status: 403,
      sandboxId: identity.sandboxId,
      roomId: sandbox.room_id,
      host: target.host,
      reason: "host_not_allowlisted",
    };
  }

  let addresses: string[];
  try {
    addresses = await resolvePublicAddresses(target.host, options.resolveHost);
  } catch {
    return {
      allowed: false,
      status: 403,
      sandboxId: identity.sandboxId,
      roomId: sandbox.room_id,
      host: target.host,
      reason: "unsafe_or_unresolved_address",
    };
  }
  return {
    allowed: true,
    sandboxId: identity.sandboxId,
    roomId: sandbox.room_id,
    host: target.host,
    address: addresses[0]!,
    port: target.port,
  };
}

function parseConnectTarget(authority: string): ConnectTarget {
  if (!authority || authority.length > 260 || /[\s/@?#\\]/.test(authority))
    throw new Error("invalid CONNECT authority");
  const url = new URL(`https://${authority}`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("invalid CONNECT authority");
  const port = url.port === "" ? 443 : Number(url.port);
  if (port !== 443) throw new Error("only HTTPS CONNECT on port 443 is allowed");
  const rawHost = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(rawHost)) throw new Error("IP literal CONNECT targets are not allowed");
  return { host: normalizeEgressHost(rawHost), port: 443 };
}

function parseProxyIdentity(value: string | string[] | undefined): ProxyIdentity | null {
  if (typeof value !== "string") return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) return null;
  const encoded = match[1]!;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) return null;
  const separator = decoded.indexOf(0x3a);
  if (separator <= 0) return null;
  let sandboxId: string;
  let credential: string;
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    sandboxId = utf8.decode(decoded.subarray(0, separator));
    credential = utf8.decode(decoded.subarray(separator + 1));
  } catch {
    return null;
  }
  if (!/^sandbox_[A-Za-z0-9_-]{8,128}$/.test(sandboxId)) return null;
  return { sandboxId, credential };
}
