import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import type { RequestListener, ServerResponse } from "node:http";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchPublicJson, PublicFetchError, type PublicFetchFailure } from "./public-fetch.js";

const PUBLIC = async () => ["93.184.216.34"];
let key: Buffer;
let cert: Buffer;
const servers: ReturnType<typeof createServer>[] = [];

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "public-fetch-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      join(dir, "k.pem"),
      "-out",
      join(dir, "c.pem"),
      "-subj",
      "/CN=agent.example",
      "-addext",
      "subjectAltName=DNS:agent.example,DNS:sub.agent.example",
    ],
    { stdio: "ignore" },
  );
  key = readFileSync(join(dir, "k.pem"));
  cert = readFileSync(join(dir, "c.pem"));
});

afterAll(() => {
  for (const server of servers) server.closeAllConnections();
});

async function serve(handler: RequestListener) {
  const server = createServer({ key, cert }, handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, seam: { port, ca: cert, connectTo: "127.0.0.1", resolve: PUBLIC } };
}

const json = (res: ServerResponse, body: unknown, type = "application/json") => {
  res.setHeader("content-type", type);
  res.end(JSON.stringify(body));
};

const reasonOf = async (promise: Promise<unknown>): Promise<PublicFetchFailure | undefined> => {
  const error = await promise.catch((e: unknown) => e);
  return error instanceof PublicFetchError ? error.reason : undefined;
};

const get = (url: string, allowHosts = ["agent.example"]) => ({
  url,
  method: "GET" as const,
  allowHosts,
});

describe("fetchPublicJson", () => {
  it("GETs JSON over TLS with the certificate checked for the real host", async () => {
    const seen: {
      url?: string | undefined;
      host?: string | undefined;
      accept?: string | undefined;
    }[] = [];
    const { seam } = await serve((req, res) => {
      seen.push({ url: req.url, host: req.headers.host, accept: req.headers.accept });
      json(res, { name: "agent" });
    });
    await expect(
      fetchPublicJson(get("https://agent.example/.well-known/agent.json?v=1"), seam),
    ).resolves.toEqual({ status: 200, json: { name: "agent" } });
    expect(seen).toEqual([
      { url: "/.well-known/agent.json?v=1", host: "agent.example", accept: "application/json" },
    ]);
    // A certificate for another name is refused: the name checked is the URL's, not the address.
    expect(
      await reasonOf(fetchPublicJson(get("https://other.example/", ["other.example"]), seam)),
    ).toBe("network");
  });

  it("POSTs a JSON body and returns the parsed response", async () => {
    const seen: {
      method?: string | undefined;
      type?: string | undefined;
      length?: string | undefined;
      body: string;
    }[] = [];
    const { seam } = await serve((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({
          method: req.method,
          type: req.headers["content-type"],
          length: req.headers["content-length"],
          body,
        });
        json(res, { ok: true }, "application/vnd.a2a+json; charset=utf-8");
      });
    });
    await expect(
      fetchPublicJson(
        { ...get("https://agent.example/rpc"), method: "POST", body: '{"a":1}' },
        seam,
      ),
    ).resolves.toEqual({ status: 200, json: { ok: true } });
    expect(seen).toEqual([
      { method: "POST", type: "application/json", length: "7", body: '{"a":1}' },
    ]);
  });

  it("refuses http, userinfo, a non-default port, an IP literal and a fragment before connecting", async () => {
    const resolve = vi.fn(PUBLIC);
    for (const url of [
      "http://agent.example/x",
      "https://user:pw@agent.example/x",
      "https://agent.example:8443/x",
      "https://93.184.216.34/x",
      "https://[2001:db8::1]/x",
      "https://agent.example/x#frag",
      "not a url",
    ]) {
      expect(
        await reasonOf(fetchPublicJson(get(url, ["agent.example", "*.example"]), { resolve })),
        url,
      ).toBe("invalid_url");
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a host the allowlist doesn't cover; an empty allowlist refuses everything", async () => {
    const resolve = vi.fn(PUBLIC);
    expect(
      await reasonOf(
        fetchPublicJson(get("https://agent.example/", ["other.example"]), { resolve }),
      ),
    ).toBe("host_not_allowed");
    expect(await reasonOf(fetchPublicJson(get("https://agent.example/", []), { resolve }))).toBe(
      "host_not_allowed",
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it("a *.suffix pattern allows a subdomain but not the apex", async () => {
    const { seam } = await serve((_req, res) => json(res, { ok: 1 }));
    await expect(
      fetchPublicJson(get("https://sub.agent.example/", ["*.agent.example"]), seam),
    ).resolves.toMatchObject({ json: { ok: 1 } });
    expect(
      await reasonOf(fetchPublicJson(get("https://agent.example/", ["*.agent.example"]), seam)),
    ).toBe("host_not_allowed");
  });

  it("refuses a name resolving to any private address", async () => {
    for (const answers of [["10.0.0.5"], ["93.184.216.34", "127.0.0.1"], []]) {
      expect(
        await reasonOf(
          fetchPublicJson(get("https://agent.example/"), { resolve: async () => answers }),
        ),
        answers.join(","),
      ).toBe("private_address");
    }
  });

  it("does not follow a 302", async () => {
    const target: string[] = [];
    const { port: targetPort } = await serve((req, res) => {
      target.push(req.url ?? "");
      json(res, {});
    });
    const { seam } = await serve((_req, res) => {
      res.statusCode = 302;
      res.setHeader("location", `https://agent.example:${targetPort}/elsewhere`);
      res.end();
    });
    const error = await fetchPublicJson(get("https://agent.example/"), seam).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ reason: "redirect", status: 302 });
    expect(target).toEqual([]);
  });

  it("a 500 is http_status with status 500", async () => {
    const { seam } = await serve((_req, res) => {
      res.statusCode = 500;
      json(res, { error: "secret details" });
    });
    const error = await fetchPublicJson(get("https://agent.example/"), seam).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ reason: "http_status", status: 500 });
    expect((error as Error).message).not.toContain("secret");
  });

  it("a text/html answer is content_type", async () => {
    const { seam } = await serve((_req, res) => json(res, {}, "text/html"));
    expect(await reasonOf(fetchPublicJson(get("https://agent.example/"), seam))).toBe(
      "content_type",
    );
  });

  it("an invalid JSON body is invalid_json", async () => {
    const { seam } = await serve((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end("{not json");
    });
    expect(await reasonOf(fetchPublicJson(get("https://agent.example/"), seam))).toBe(
      "invalid_json",
    );
  });

  it("stops reading past maxResponseBytes", async () => {
    const { seam } = await serve((_req, res) => json(res, { pad: "x".repeat(10_000) }));
    expect(
      await reasonOf(
        fetchPublicJson(get("https://agent.example/"), { ...seam, maxResponseBytes: 1_000 }),
      ),
    ).toBe("too_large");
    expect(
      await reasonOf(
        fetchPublicJson(
          { ...get("https://agent.example/"), method: "POST", body: "x".repeat(2_000) },
          { ...seam, maxRequestBytes: 1_000 },
        ),
      ),
    ).toBe("too_large");
  });

  it("a trickling server ends at the deadline", async () => {
    const { seam } = await serve((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.write("{");
      const timer = setInterval(() => res.write(" "), 50);
      res.on("close", () => clearInterval(timer));
    });
    const started = Date.now();
    expect(
      await reasonOf(fetchPublicJson(get("https://agent.example/"), { ...seam, deadlineMs: 400 })),
    ).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(400 + 1_000);
  });

  it("a header Node refuses is a PublicFetchError, not a stray TypeError", async () => {
    const { seam } = await serve((_req, res) => json(res, {}));
    for (const headers of [{ "bad name": "x" }, { "x-a": "line\r\nbreak" }]) {
      const error = await fetchPublicJson(
        { ...get("https://agent.example/"), headers },
        seam,
      ).catch((e: unknown) => e);
      expect(error, JSON.stringify(headers)).toBeInstanceOf(PublicFetchError);
      expect((error as PublicFetchError).reason).toBe("invalid_url");
    }
  });

  it("caller cannot override host or content-length headers", async () => {
    const seen: Record<string, string | undefined>[] = [];
    const { seam } = await serve((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({
          host: req.headers.host,
          length: req.headers["content-length"],
          type: req.headers["content-type"],
          extra: req.headers["x-extra"] as string,
        });
        json(res, {});
      });
    });
    await fetchPublicJson(
      {
        ...get("https://agent.example/"),
        method: "POST",
        body: "{}",
        headers: {
          Host: "evil.example",
          "Content-Length": "999",
          "Content-Type": "text/plain",
          "x-extra": "kept",
        },
      },
      seam,
    );
    expect(seen).toEqual([
      { host: "agent.example", length: "2", type: "application/json", extra: "kept" },
    ]);
  });
});
