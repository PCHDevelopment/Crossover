import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { postWebhook } from "./webhook.js";

const request = (url: string) => ({ url, body: "{}", headers: {} });

describe("postWebhook", () => {
  it("refuses what isn't a plain public https URL, before connecting to anything", async () => {
    for (const url of [
      "http://hooks.example/x",
      "https://user:pw@hooks.example/x",
      "https://hooks.example:8443/x",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://[::1]/x",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      await expect(
        postWebhook(request(url), { resolve: async () => ["93.184.216.34"] }),
        url,
      ).rejects.toThrow();
    }
  });

  it("refuses a name that resolves to a private address, or to a mix with one", async () => {
    await expect(
      postWebhook(request("https://hooks.example/x"), { resolve: async () => ["10.0.0.5"] }),
    ).rejects.toThrow(/public/);
    await expect(
      postWebhook(request("https://hooks.example/x"), {
        resolve: async () => ["93.184.216.34", "127.0.0.1"],
      }),
    ).rejects.toThrow(/public/);
    await expect(
      postWebhook(request("https://nope.example/x"), { resolve: async () => [] }),
    ).rejects.toThrow();
  });

  it("delivers over TLS: the certificate is checked for the real host name, and the body, headers and path arrive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webhook-"));
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
        "/CN=hooks.example",
        "-addext",
        "subjectAltName=DNS:hooks.example",
      ],
      { stdio: "ignore" },
    );
    const cert = readFileSync(join(dir, "c.pem"));
    const seen: { url: string | undefined; host: string | undefined; sig: string; body: string }[] =
      [];
    let status = 204;
    const server = createServer({ key: readFileSync(join(dir, "k.pem")), cert }, (req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({
          url: req.url,
          host: req.headers.host,
          sig: req.headers["x-sig"] as string,
          body,
        });
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const seam = { port, ca: cert, connectTo: "127.0.0.1", resolve: async () => ["93.184.216.34"] };
    try {
      const sent = {
        url: "https://hooks.example/a/b?x=1",
        body: '{"a":1}',
        headers: { "x-sig": "s" },
      };
      await expect(postWebhook(sent, seam)).resolves.toEqual({ status: 204 });
      expect(seen[0]).toEqual({
        url: "/a/b?x=1",
        host: "hooks.example",
        sig: "s",
        body: '{"a":1}',
      });
      // A non-2xx answer is a failure; a certificate for another name is refused.
      status = 500;
      await expect(postWebhook(sent, seam)).rejects.toThrow(/500/);
      await expect(
        postWebhook({ ...sent, url: "https://other.example/x" }, seam),
      ).rejects.toThrow();
      expect(seen).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it("gives up at the overall deadline on a receiver that never answers, and on one that trickles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webhook-slow-"));
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
        "/CN=hooks.example",
        "-addext",
        "subjectAltName=DNS:hooks.example",
      ],
      { stdio: "ignore" },
    );
    const cert = readFileSync(join(dir, "c.pem"));
    let mode: "silent" | "trickle" = "silent";
    const timers: NodeJS.Timeout[] = [];
    const server = createServer({ key: readFileSync(join(dir, "k.pem")), cert }, (req, res) => {
      req.resume();
      req.on("end", () => {
        if (mode === "silent") return; // never answers
        res.writeHead(200, { "content-type": "text/plain" });
        const timer = setInterval(() => res.write("x"), 50); // a byte every 50 ms, for ever
        timers.push(timer);
        res.on("close", () => clearInterval(timer));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const seam = {
      port,
      ca: cert,
      connectTo: "127.0.0.1",
      resolve: async () => ["93.184.216.34"],
      deadlineMs: 400,
    };
    try {
      for (const next of ["silent", "trickle"] as const) {
        mode = next;
        const started = Date.now();
        await expect(postWebhook(request("https://hooks.example/x"), seam), next).rejects.toThrow();
        expect(Date.now() - started, next).toBeLessThan(2_000);
      }
      // A name lookup that never finishes is cut off by the same deadline.
      const started = Date.now();
      await expect(
        postWebhook(request("https://hooks.example/x"), {
          ...seam,
          resolve: () => new Promise<string[]>(() => undefined),
        }),
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      for (const t of timers) clearInterval(t);
      server.closeAllConnections();
      server.close();
    }
  });
});
