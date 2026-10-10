import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import process from "node:process";
import { URL } from "node:url";
import { createPool } from "/repo/packages/db/dist/index.js";
import { createEgressProxyServer } from "/repo/apps/egress-proxy/dist/index.js";

const pool = createPool(process.env.DATABASE_URL);
const fixture = createHttpsServer(
  {
    cert: readFileSync("/test-certs/server.crt"),
    key: readFileSync("/test-certs/server.key"),
  },
  (request, response) => {
    const path = new URL(request.url ?? "/", "https://browser-fixture.test").pathname;
    if (path === "/redirect") {
      response.writeHead(302, { location: "https://off-list.browser-fixture.test/" });
      response.end();
      return;
    }
    if (path === "/long") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<title>Long fixture</title><body>${"é".repeat(32_769)}</body>`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<title>Browser fixture</title><body>fixture text <a href="https://browser-fixture.test/next">allowed link</a><a href="http://browser-fixture.test/plain">http link</a></body>',
    );
  },
);
fixture.listen(8443, "127.0.0.1");

const proxy = createEgressProxyServer({
  pool,
  secret: process.env.SANDBOX_EGRESS_PROXY_SECRET,
  resolveHost: async (host) => (host === "browser-fixture.test" ? ["93.184.216.34"] : []),
  connect: () => connect({ host: "127.0.0.1", port: 8443 }),
});
proxy.listen(3128, "0.0.0.0", () => {
  process.stdout.write('{"event":"browser_test_proxy_started"}\n');
});

const shutdown = () => {
  proxy.close();
  fixture.close();
  void pool.end();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
