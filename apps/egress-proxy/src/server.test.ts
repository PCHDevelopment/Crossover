import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { connect as tcpConnect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
  createServer as createTlsServer,
  connect as tlsConnect,
  type Server as TlsServer,
} from "node:tls";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEgressProxyServer, type EgressLog, type EgressProxyOptions } from "./server.js";
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
  const started = await startProxy();
  proxy = started.server;
  proxyPort = started.port;
}, 60_000);

// A test that fails or times out must not leave the participant PAUSED for the next one (T1558).
afterEach(async () => {
  await fixture.db.pool.query("UPDATE participants SET status = 'ACTIVE' WHERE id = $1", [
    fixture.participantId,
  ]);
});

beforeEach(() => {
  logs.length = 0;
});

afterAll(async () => {
  if (proxy) await close(proxy);
  if (tlsServer) await close(tlsServer);
  if (fixture) await fixture.db.drop();
});

describe("egress proxy transport", () => {
  it("refuses plain HTTP", async () => {
    expect(await requestPlainHttp(proxyPort)).toMatch(/^HTTP\/1\.1 405/);
    expect(logs.at(-1)).toMatchObject({ host: "registry.npmjs.org", allowed: false });
  });

  it("tries every pinned public address and logs the successful TLS tunnel", async () => {
    const attempted: string[] = [];
    await withProxy(
      {
        resolveHost: async () => ["93.184.216.34", "2606:4700:4700::1111"],
        connect: (address, port) => {
          attempted.push(address);
          if (attempted.length === 1) throw new Error("first route unavailable");
          return tcpConnect({ host: "127.0.0.1", port: tlsPort || port });
        },
      },
      async (port) => {
        const tunnel = await requestConnectAt(port, "registry.npmjs.org:443");
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
      },
    );

    expect(attempted).toEqual(["93.184.216.34", "2606:4700:4700::1111"]);
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

  it("denies unlisted hosts, bad credentials, and names resolving to IMDS over CONNECT", async () => {
    const unlisted = await requestConnectAt(proxyPort, "example.com:443");
    expect(unlisted.status).toBe(403);
    unlisted.socket.destroy();

    const badCredential = await requestConnectAt(
      proxyPort,
      "registry.npmjs.org:443",
      "Basic Zm9vOmJhcg==",
    );
    expect(badCredential.status).toBe(407);
    badCredential.socket.destroy();

    await withProxy({ resolveHost: async () => ["169.254.169.254"] }, async (port) => {
      const imds = await requestConnectAt(port, "registry.npmjs.org:443");
      expect(imds.status).toBe(403);
      expect(logs.at(-1)).toMatchObject({
        host: "registry.npmjs.org",
        allowed: false,
        reason: "unsafe_or_unresolved_address",
      });
      imds.socket.destroy();
    });
  });

  it("survives a client reset while authorization is pending", async () => {
    const client = tcpConnect({ host: "127.0.0.1", port: proxyPort });
    client.on("error", () => {});
    await once(client, "connect");
    client.write(
      "CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\nProxy-Authorization: Basic Zm9vOmJhcg==\r\n\r\n",
    );
    client.resetAndDestroy();
    await once(client, "close");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(proxy.listening).toBe(true);
  });

  it("destroys a timed-out upstream and survives its later socket error", async () => {
    const upstream = new TimedOutSocket();
    const lateError = new Promise<void>((resolve) => upstream.once("lateError", resolve));
    await withProxy({ connect: () => upstream as unknown as Socket }, async (port, server) => {
      const response = await requestConnectAt(port, "registry.npmjs.org:443");
      expect(response.status).toBe(502);
      response.socket.destroy();
      await lateError;
      expect(upstream.destroyed).toBe(true);
      expect(server.listening).toBe(true);
      expect(logs.at(-1)).toMatchObject({
        allowed: true,
        reason: "upstream_connect_failed",
      });
    });
  });

  it("closes an idle tunnel and logs the timeout", async () => {
    await withProxy({ idleTimeoutMs: 100 }, async (port) => {
      const tunnel = await requestConnectAt(port, "registry.npmjs.org:443");
      expect(tunnel.status).toBe(200);
      await once(tunnel.socket, "close");
      expect(logs.at(-1)).toMatchObject({
        sandbox_id: fixture.sandboxId,
        allowed: true,
        reason: "tunnel_idle_timeout",
      });
    });
  });

  it("limits active tunnels per sandbox and releases a slot after close", async () => {
    await withProxy({ maxTunnelsPerSandbox: 2, idleTimeoutMs: 60_000 }, async (port) => {
      const first = await requestConnectAt(port, "registry.npmjs.org:443");
      const second = await requestConnectAt(port, "registry.npmjs.org:443");
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const limited = await requestConnectAt(port, "registry.npmjs.org:443");
      expect(limited.status).toBe(503);
      expect(logs.at(-1)).toMatchObject({
        sandbox_id: fixture.sandboxId,
        allowed: false,
        reason: "sandbox_tunnel_limit",
      });
      limited.socket.destroy();

      const firstClosed = once(first.socket, "close");
      first.socket.destroy();
      await firstClosed;
      // The client-side close can arrive before the proxy observes the TCP close
      // and releases its reservation. Retry briefly to avoid asserting across
      // that network scheduling boundary.
      let afterRelease: Awaited<ReturnType<typeof requestConnectAt>> | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = await requestConnectAt(port, "registry.npmjs.org:443");
        if (candidate.status === 200) {
          afterRelease = candidate;
          break;
        }
        candidate.socket.destroy();
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(afterRelease?.status).toBe(200);
      second.socket.destroy();
      afterRelease?.socket.destroy();
    });
  });

  it("expires a long-lived tunnel and rechecks participant status on reconnect", async () => {
    await withProxy({ idleTimeoutMs: 2_000, maxTunnelLifetimeMs: 100 }, async (port) => {
      const tunnel = await requestConnectAt(port, "registry.npmjs.org:443");
      expect(tunnel.status).toBe(200);
      // The proxy's lifetime timer (100 ms here) is already running: listen for the close before
      // awaiting anything else, or a slow runner closes the socket before the listener exists and
      // `once` never resolves (T1558).
      const closed = once(tunnel.socket, "close");
      await fixture.db.pool.query("UPDATE participants SET status = 'PAUSED' WHERE id = $1", [
        fixture.participantId,
      ]);
      await closed;
      expect(logs.at(-1)).toMatchObject({
        sandbox_id: fixture.sandboxId,
        allowed: true,
        reason: "tunnel_lifetime_exceeded",
      });
      const reconnect = await requestConnectAt(port, "registry.npmjs.org:443");
      expect(reconnect.status).toBe(403);
      reconnect.socket.destroy();
    });
  });

  it("restores room settings after refusing a malformed allowlist", async () => {
    const { rows } = await fixture.db.pool.query<{ settings: unknown }>(
      "SELECT settings FROM rooms WHERE id = $1",
      [fixture.roomId],
    );
    const previousSettings = rows[0]!.settings;
    try {
      await fixture.db.pool.query("UPDATE rooms SET settings = $2 WHERE id = $1", [
        fixture.roomId,
        JSON.stringify({ egress_allowlist: "example.com" }),
      ]);
      const denied = await requestConnectAt(proxyPort, "registry.npmjs.org:443");
      expect(denied.status).toBe(403);
      expect(logs.at(-1)).toMatchObject({ allowed: false, reason: "invalid_room_allowlist" });
      denied.socket.destroy();
    } finally {
      await fixture.db.pool.query("UPDATE rooms SET settings = $2 WHERE id = $1", [
        fixture.roomId,
        JSON.stringify(previousSettings),
      ]);
    }
  });
});

class TimedOutSocket extends EventEmitter {
  destroyed = false;

  setTimeout(milliseconds: number): this {
    if (milliseconds > 0) setImmediate(() => this.emit("timeout"));
    return this;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      setImmediate(() => {
        this.emit("error", new Error("late ETIMEDOUT"));
        this.emit("lateError");
      });
    }
    return this;
  }
}

function authorization(): string {
  return proxyAuthorization(fixture.sandboxId, SECRET);
}

async function startProxy(
  overrides: Partial<EgressProxyOptions> = {},
): Promise<{ server: HttpServer; port: number }> {
  const server = createEgressProxyServer({
    pool: fixture.db.pool,
    secret: SECRET,
    resolveHost: async () => ["93.184.216.34"],
    connect: (_address, port) => tcpConnect({ host: "127.0.0.1", port: tlsPort || port }),
    logger: (entry) => logs.push(entry),
    ...overrides,
  });
  return { server, port: await listen(server) };
}

async function withProxy<T>(
  overrides: Partial<EgressProxyOptions>,
  action: (port: number, server: HttpServer) => Promise<T>,
): Promise<T> {
  const started = await startProxy(overrides);
  try {
    return await action(started.port, started.server);
  } finally {
    await close(started.server);
  }
}

async function requestConnectAt(
  port: number,
  authority: string,
  proxyAuthorizationHeader = authorization(),
): Promise<{ socket: Socket; status: number }> {
  const socket = tcpConnect({ host: "127.0.0.1", port });
  await once(socket, "connect");
  const headers = await readHeaders(
    socket,
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${proxyAuthorizationHeader}\r\n\r\n`,
  );
  return { socket, status: Number(/^HTTP\/1\.1 (\d+)/.exec(headers)?.[1]) };
}

async function requestPlainHttp(port: number): Promise<string> {
  const socket = tcpConnect({ host: "127.0.0.1", port });
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
