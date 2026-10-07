import { request } from "node:https";
import { resolvePublicAddresses, type HostResolver } from "./network.js";

export interface WebhookRequest {
  /** An `https` URL on the default port, no credentials in it. */
  url: string;
  body: string;
  headers: Record<string, string>;
}

export interface PostWebhookOptions {
  /**
   * The deadline for the whole exchange, name lookup included (default 10 s): a receiver that
   * answers a byte at a time still ends here.
   */
  deadlineMs?: number;
  /** For tests only: the port to connect to (default 443) and extra trusted certificates. */
  port?: number;
  /** For tests only: connect here instead of the resolved (and checked) address. */
  connectTo?: string;
  ca?: string | Buffer;
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
  const deadlineMs = options.deadlineMs ?? 10_000;
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("webhook timed out")), deadlineMs);
  });
  try {
    const [address] = await Promise.race([
      resolvePublicAddresses(hostname, options.resolve),
      expired,
    ]);
    return await Promise.race([
      send(
        req,
        url,
        hostname,
        options.connectTo ?? address!,
        options,
        Math.max(1, deadlineMs - (Date.now() - started)),
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function send(
  req: WebhookRequest,
  url: URL,
  hostname: string,
  address: string,
  options: PostWebhookOptions,
  remainingMs: number,
): Promise<{ status: number }> {
  const maxBytes = options.maxResponseBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    const clientReq = request(
      {
        host: address,
        port: options.port ?? 443,
        ...(options.ca ? { ca: options.ca } : {}),
        method: "POST",
        path: `${url.pathname}${url.search}`,
        servername: hostname,
        headers: {
          ...req.headers,
          host: url.host,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(req.body)),
        },
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
    // The overall deadline also destroys the socket, so nothing lingers once it has passed.
    const kill = setTimeout(() => clientReq.destroy(new Error("webhook timed out")), remainingMs);
    clientReq.on("close", () => clearTimeout(kill));
    clientReq.on("error", reject);
    clientReq.end(req.body);
  });
}
