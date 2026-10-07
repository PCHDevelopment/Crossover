import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as tcpConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { authorizeConnect, type EgressPolicyOptions } from "./policy.js";
import { normalizeEgressHost } from "./allowlist.js";

const MAX_HEADER_SIZE = 8 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_TUNNEL_LIFETIME_MS = 10 * 60_000;
const MAX_TUNNELS_PER_SANDBOX = 32;

export interface EgressLog {
  timestamp: string;
  event: "egress";
  sandbox_id?: string;
  room_id?: string;
  host: string;
  allowed: boolean;
  bytes_from_sandbox: number;
  bytes_to_sandbox: number;
  reason?: string;
}

export interface EgressProxyOptions extends EgressPolicyOptions {
  /** Test seam; production connects to the exact IP returned by the checked resolver. */
  connect?: (address: string, port: number) => Socket;
  logger?: (entry: EgressLog) => void;
  /** Test seams for the production tunnel limits. */
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxTunnelLifetimeMs?: number;
  maxTunnelsPerSandbox?: number;
}

/** A CONNECT-only HTTPS proxy with room policy, per-sandbox identity, and pinned public DNS. */
export function createEgressProxyServer(options: EgressProxyOptions): Server {
  if (Buffer.byteLength(options.secret) < 32)
    throw new Error("SANDBOX_EGRESS_PROXY_SECRET must be at least 32 bytes");
  const server = createServer({ maxHeaderSize: MAX_HEADER_SIZE }, (request, response) => {
    refusePlainHttp(request, response, options.logger);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 1_000;
  const activeTunnels = new Map<string, Set<object>>();
  server.on("connect", (request, client, head) => {
    client.on("error", () => client.destroy());
    void handleConnect(request, client, head, options, activeTunnels).catch(() => {
      log(options.logger, {
        host: safeHostForLog(request.url),
        allowed: false,
        reason: "internal_error",
      });
      writeProxyError(client, 502, "Bad Gateway");
    });
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

async function handleConnect(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  options: EgressProxyOptions,
  activeTunnels: Map<string, Set<object>>,
): Promise<void> {
  const decision = await authorizeConnect(
    request.url ?? "",
    request.headers["proxy-authorization"],
    options,
  );
  if (!decision.allowed) {
    log(options.logger, {
      ...(decision.sandboxId ? { sandbox_id: decision.sandboxId } : {}),
      ...(decision.roomId ? { room_id: decision.roomId } : {}),
      host: decision.host,
      allowed: false,
      reason: decision.reason,
    });
    writeProxyError(
      client,
      decision.status,
      statusPhrase(decision.status),
      decision.status === 407,
    );
    return;
  }

  if (client.destroyed) return;
  const maxTunnels = options.maxTunnelsPerSandbox ?? MAX_TUNNELS_PER_SANDBOX;
  const sandboxTunnels = activeTunnels.get(decision.sandboxId) ?? new Set<object>();
  if (sandboxTunnels.size >= maxTunnels) {
    log(options.logger, {
      sandbox_id: decision.sandboxId,
      room_id: decision.roomId,
      host: decision.host,
      allowed: false,
      reason: "sandbox_tunnel_limit",
    });
    writeProxyError(client, 503, "Service Unavailable");
    return;
  }
  const reservation = {};
  sandboxTunnels.add(reservation);
  activeTunnels.set(decision.sandboxId, sandboxTunnels);
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    sandboxTunnels.delete(reservation);
    if (sandboxTunnels.size === 0) activeTunnels.delete(decision.sandboxId);
  };

  let upstream: Socket;
  try {
    upstream = await connectToPinnedAddress(decision.addresses, decision.port, client, options);
  } catch {
    releaseSlot();
    log(options.logger, {
      sandbox_id: decision.sandboxId,
      room_id: decision.roomId,
      host: decision.host,
      allowed: true,
      bytes_from_sandbox: 0,
      bytes_to_sandbox: 0,
      reason: "upstream_connect_failed",
    });
    writeProxyError(client, 502, "Bad Gateway");
    return;
  }

  if (client.destroyed) {
    upstream.destroy();
    releaseSlot();
    return;
  }
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  let bytesFromSandbox = head.length;
  let bytesToSandbox = 0;
  let logged = false;
  let finished = false;
  let idleTimer: NodeJS.Timeout;
  const logTunnel = (reason?: string) => {
    if (logged) return;
    logged = true;
    log(options.logger, {
      sandbox_id: decision.sandboxId,
      room_id: decision.roomId,
      host: decision.host,
      allowed: true,
      bytes_from_sandbox: bytesFromSandbox,
      bytes_to_sandbox: bytesToSandbox,
      ...(reason ? { reason } : {}),
    });
  };

  const finish = (reason?: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(idleTimer);
    clearTimeout(lifetimeTimer);
    releaseSlot();
    logTunnel(reason);
  };
  const closeTunnel = (reason: string) => {
    finish(reason);
    client.destroy();
    upstream.destroy();
  };
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => closeTunnel("tunnel_idle_timeout"),
      options.idleTimeoutMs ?? IDLE_TIMEOUT_MS,
    );
    idleTimer.unref();
  };
  const lifetimeTimer = setTimeout(
    () => closeTunnel("tunnel_lifetime_exceeded"),
    options.maxTunnelLifetimeMs ?? MAX_TUNNEL_LIFETIME_MS,
  );
  lifetimeTimer.unref();

  client.on("data", (chunk: Buffer) => {
    bytesFromSandbox += chunk.length;
    resetIdleTimer();
  });
  upstream.on("data", (chunk: Buffer) => {
    bytesToSandbox += chunk.length;
    resetIdleTimer();
  });
  client.on("error", () => closeTunnel("client_error"));
  upstream.on("error", () => closeTunnel("upstream_error"));
  client.once("close", () => {
    finish();
    upstream.destroy();
  });
  upstream.once("close", () => {
    finish();
    client.destroy();
  });
  resetIdleTimer();
  if (head.length > 0) upstream.write(head);
  client.pipe(upstream);
  upstream.pipe(client);
}

async function connectToPinnedAddress(
  addresses: string[],
  port: number,
  client: Duplex,
  options: EgressProxyOptions,
): Promise<Socket> {
  const connect =
    options.connect ??
    ((address: string, targetPort: number) => tcpConnect({ host: address, port: targetPort }));
  let lastError: unknown;
  for (const address of addresses) {
    if (client.destroyed) throw new Error("client closed before upstream connected");
    let socket: Socket;
    try {
      socket = connect(address, port);
    } catch (error) {
      lastError = error;
      continue;
    }
    // Keep a listener after a timeout or destroy so a late OS error cannot crash the proxy.
    socket.on("error", () => {
      // The connect attempt has its own listener; keep consuming errors after cancellation.
    });
    const onClientClose = () => socket.destroy();
    client.once("close", onClientClose);
    try {
      await waitForConnect(socket, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
      if (client.destroyed) throw new Error("client closed before upstream connected");
      return socket;
    } catch (error) {
      lastError = error;
      socket.destroy();
      if (client.destroyed) throw error;
    } finally {
      client.off("close", onClientClose);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("upstream connection failed");
}

function waitForConnect(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("upstream connect timed out")), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.setTimeout(0);
      socket.off("connect", connected);
      socket.off("error", failed);
      socket.off("timeout", timedOut);
      if (error) reject(error);
      else resolve();
    };
    const connected = () => finish();
    const failed = (error: Error) => finish(error);
    const timedOut = () => finish(new Error("upstream connect timed out"));
    socket.once("connect", connected);
    socket.once("error", failed);
    socket.once("timeout", timedOut);
    socket.setTimeout(timeoutMs);
  });
}

function refusePlainHttp(
  request: IncomingMessage,
  response: ServerResponse,
  logger: EgressProxyOptions["logger"],
): void {
  const host = safeHostForLog(request.headers.host);
  log(logger, { host, allowed: false, reason: "plain_http_refused" });
  response.writeHead(405, { connection: "close", "content-length": "0" });
  response.end();
}

function safeHostForLog(value: string | undefined): string {
  if (!value) return "<invalid>";
  try {
    const parsed = new URL(`https://${value}`);
    if (parsed.username || parsed.password) return "<invalid>";
    return normalizeEgressHost(parsed.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return "<invalid>";
  }
}

function statusPhrase(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 403:
      return "Forbidden";
    case 407:
      return "Proxy Authentication Required";
    case 503:
      return "Service Unavailable";
    default:
      return "Bad Gateway";
  }
}

function log(
  logger: EgressProxyOptions["logger"],
  entry: Omit<EgressLog, "timestamp" | "event" | "bytes_from_sandbox" | "bytes_to_sandbox"> &
    Partial<Pick<EgressLog, "bytes_from_sandbox" | "bytes_to_sandbox">>,
): void {
  const record: EgressLog = {
    timestamp: new Date().toISOString(),
    event: "egress",
    ...entry,
    bytes_from_sandbox: entry.bytes_from_sandbox ?? 0,
    bytes_to_sandbox: entry.bytes_to_sandbox ?? 0,
  };
  (logger ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`)))(record);
}

function writeProxyError(
  socket: Duplex | ServerResponse,
  status: number,
  phrase: string,
  authenticate = false,
): void {
  if (!socket.writable) return;
  const auth = authenticate ? 'Proxy-Authenticate: Basic realm="crossover-egress"\r\n' : "";
  socket.end(
    `HTTP/1.1 ${status} ${phrase}\r\n${auth}Connection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}
