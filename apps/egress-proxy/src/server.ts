import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as tcpConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { authorizeConnect, type EgressPolicyOptions } from "./policy.js";
import { normalizeEgressHost } from "./allowlist.js";

const MAX_HEADER_SIZE = 8 * 1024;
const CONNECT_TIMEOUT_MS = 5_000;

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
  server.on("connect", (request, client, head) => {
    void handleConnect(request, client, head, options).catch(() => {
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

  let upstream: Socket;
  try {
    upstream = (options.connect ?? ((address, port) => tcpConnect({ host: address, port })))(
      decision.address,
      decision.port,
    );
    await waitForConnect(upstream);
  } catch {
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
    return;
  }
  client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  let bytesFromSandbox = head.length;
  let bytesToSandbox = 0;
  let logged = false;
  const finish = () => {
    if (logged) return;
    logged = true;
    log(options.logger, {
      sandbox_id: decision.sandboxId,
      room_id: decision.roomId,
      host: decision.host,
      allowed: true,
      bytes_from_sandbox: bytesFromSandbox,
      bytes_to_sandbox: bytesToSandbox,
    });
  };
  client.on("data", (chunk: Buffer) => (bytesFromSandbox += chunk.length));
  upstream.on("data", (chunk: Buffer) => (bytesToSandbox += chunk.length));
  client.once("close", finish);
  upstream.once("close", finish);
  client.once("end", finish);
  upstream.once("end", finish);
  client.once("error", finish);
  upstream.once("error", finish);
  client.once("close", () => upstream.destroy());
  upstream.once("close", () => client.destroy());
  if (head.length > 0) upstream.write(head);
  client.pipe(upstream);
  upstream.pipe(client);
}

function waitForConnect(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error("upstream connect timed out")),
      CONNECT_TIMEOUT_MS,
    );
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
    socket.setTimeout(CONNECT_TIMEOUT_MS);
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
