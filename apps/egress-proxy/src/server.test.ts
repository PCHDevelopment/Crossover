import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { connect as tcpConnect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  createServer as createTlsServer,
  connect as tlsConnect,
  type Server as TlsServer,
} from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEgressProxyServer, type EgressLog } from "./server.js";
import { proxyAuthorization } from "./test-fixtures/auth.js";
import { createProxyTestFixture, type ProxyTestFixture } from "./test-fixtures/database.js";

const SECRET = "0123456789abcdef0123456789abcdef";
let fixture: ProxyTestFixture;
let proxy: HttpServer;
let tlsServer: TlsServer;
let proxyPort: number;
let tlsPort: number;
const logs: EgressLog[] = [];

beforeAll(async () => {
  fixture = await createProxyTestFixture();
  const key = readFileSync(
    fileURLToPath(new URL("./test-fixtures/registry-key.pem", import.meta.url)),
  );
  const cert = readFileSync(
    fileURLToPath(new URL("./test-fixtures/registry-cert.pem", import.meta.url)),
  );
  tlsServer = createTlsServer({ key, cert }, (socket) => {
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("utf8");
      if (request.includes("\r\n\r\n"))
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    });
  });
  tlsPort = await listen(tlsServer);
  proxy = createEgressProxyServer({
    pool: fixture.db.pool,
    secret: SECRET,
    resolveHost: async () => ["93.184.216.34"],
    connect: (address, port) => {
      expect(address).toBe("93.184.216.34");
      return tcpConnect({ host: "127.0.0.1", port: tlsPort || port });
    },
    logger: (entry) => logs.push(entry),
  });
  proxyPort = await listen(proxy);
}, 60_000);

afterAll(async () => {
  if (proxy) await close(proxy);
  if (tlsServer) await close(tlsServer);
  if (fixture) await fixture.db.drop();
});

describe("egress proxy transport", () => {
  it("refuses plain HTTP", async () => {
    expect(await requestPlainHttp()).toMatch(/^HTTP\/1\.1 405/);
    expect(logs.at(-1)).toMatchObject({ host: "registry.npmjs.org", allowed: false });
  });

  it("tunnels an allowlisted TLS host and logs its host, decision, and byte counts", async () => {
    const tunnel = await requestConnect("registry.npmjs.org:443");
    expect(tunnel.status).toBe(200);
    const secure = tlsConnect({
      socket: tunnel.socket,
      servername: "registry.npmjs.org",
      rejectUnauthorized: false,
    });
    await once(secure, "secureConnect");
    const body = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      secure.on("data", (chunk: Buffer) => chunks.push(chunk));
      secure.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      secure.once("error", reject);
    });
    secure.write("GET /test HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n");
    expect(await body).toContain("\r\n\r\nok");
    secure.destroy();
    if (!secure.closed) await once(secure, "close");
    if (!tunnel.socket.closed) await once(tunnel.socket, "close");

    const entry = logs.findLast((log) => log.host === "registry.npmjs.org");
    expect(entry).toMatchObject({
      sandbox_id: fixture.sandboxId,
      room_id: fixture.roomId,
      allowed: true,
    });
    expect(entry!.bytes_from_sandbox).toBeGreaterThan(0);
    expect(entry!.bytes_to_sandbox).toBeGreaterThan(0);
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  it("denies CONNECT when the room egress policy is malformed", async () => {
    await fixture.db.pool.query("UPDATE rooms SET settings = $2 WHERE id = $1", [
      fixture.roomId,
      JSON.stringify({ egress_allowlist: "example.com" }),
    ]);
    const denied = await requestConnect("registry.npmjs.org:443");
    expect(denied.status).toBe(403);
    expect(logs.at(-1)).toMatchObject({ allowed: false, reason: "invalid_room_allowlist" });
  });
});

function authorization(): string {
  return proxyAuthorization(fixture.sandboxId, SECRET);
}

async function requestConnect(authority: string): Promise<{ socket: Socket; status: number }> {
  const socket = tcpConnect({ host: "127.0.0.1", port: proxyPort });
  await once(socket, "connect");
  const headers = await readHeaders(
    socket,
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${authorization()}\r\n\r\n`,
  );
  return { socket, status: Number(/^HTTP\/1\.1 (\d+)/.exec(headers)?.[1]) };
}

async function requestPlainHttp(): Promise<string> {
  const socket = tcpConnect({ host: "127.0.0.1", port: proxyPort });
  await once(socket, "connect");
  const response = await readHeaders(
    socket,
    "GET http://registry.npmjs.org/ HTTP/1.1\r\nHost: registry.npmjs.org\r\nConnection: close\r\n\r\n",
  );
  socket.destroy();
  return response;
}

function readHeaders(socket: Socket, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      socket.off("error", onError);
      socket.pause();
      const remaining = received.subarray(end + 4);
      if (remaining.length) socket.unshift(remaining);
      resolve(received.subarray(0, end + 4).toString("latin1"));
    };
    const onError = (error: Error) => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.write(request);
  });
}

function listen(server: HttpServer | TlsServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("listener has no TCP port"));
      else resolve(address.port);
    });
  });
}

function close(server: HttpServer | TlsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
