import { request } from "node:https";
import { resolvePublicAddresses, type HostResolver } from "./network.js";

export interface WebhookRequest {
  /** An `https` URL on the default port, no credentials in it. */
  url: string;
  body: string;
  headers: Record<string, string>;
}

export interface PostWebhookOptions {
  /** Default 5 s for the whole request. */
  timeoutMs?: number;
  resolve?: HostResolver;
  /** Largest response body read before giving up on it (the body is never used). Default 64 KiB. */
  maxResponseBytes?: number;
}

/**
 * POST to a user-supplied URL without letting it reach anything inside (SSRF, §23): `https` only,
 * the host is resolved once and must resolve **only** to public addresses, the connection goes to
 * that very address (so DNS can't change between the check and the connect), the certificate is
 * checked for the real host name, redirects are not followed, and the request and the response
 * are bounded. Resolves for any 2xx; anything else rejects.
 */
export async function postWebhook(
  req: WebhookRequest,
  options: PostWebhookOptions = {},
): Promise<{ status: number }> {
  const url = new URL(req.url);
  if (url.protocol !== "https:") throw new Error("webhook URL must be https");
  if (url.username !== "" || url.password !== "")
    throw new Error("webhook URL must not carry credentials");
  if (url.port !== "" && url.port !== "443")
    throw new Error("webhook URL must use the default port");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const [address] = await resolvePublicAddresses(hostname, options.resolve);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxBytes = options.maxResponseBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    const clientReq = request(
      {
        host: address,
        port: 443,
        method: "POST",
        path: `${url.pathname}${url.search}`,
        servername: hostname,
        headers: {
          ...req.headers,
          host: url.host,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(req.body)),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) res.destroy(new Error("webhook response too large"));
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve({ status });
          else reject(new Error(`webhook answered ${status}`));
        });
        res.on("error", reject);
      },
    );
    clientReq.on("timeout", () => clientReq.destroy(new Error("webhook timed out")));
    clientReq.on("error", reject);
    clientReq.end(req.body);
  });
}
