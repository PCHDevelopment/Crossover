import { request } from "node:https";
import { isIP } from "node:net";
import { matchesHostPattern, normalizeEgressHost } from "./egress-allowlist.js";
import { resolvePublicAddresses, type HostResolver } from "./network.js";

export type PublicFetchFailure =
  | "invalid_url"
  | "host_not_allowed"
  | "private_address"
  | "timeout"
  | "redirect"
  | "http_status"
  | "too_large"
  | "content_type"
  | "invalid_json"
  | "network";

/** Message is platform wording only (never echoes remote content), safe to store and show. */
export class PublicFetchError extends Error {
  constructor(
    readonly reason: PublicFetchFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PublicFetchError";
  }
}

export interface PublicFetchRequest {
  url: string;
  method: "GET" | "POST";
  /** JSON text; POST only. */
  body?: string;
  headers?: Record<string, string>;
  /** Normalized patterns (exact or *.suffix). Empty = nothing is allowed. */
  allowHosts: readonly string[];
}

export interface PublicFetchOptions {
  /** The deadline for the whole exchange, name lookup included. Default 10 s. */
  deadlineMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  /** For tests only, with the same meaning as in PostWebhookOptions. */
  port?: number;
  connectTo?: string;
  ca?: string | Buffer;
  resolve?: HostResolver;
}

const MAX_URL_LENGTH = 2_048;
const OWN_HEADERS = new Set(["host", "content-length", "content-type"]);
const JSON_TYPE = /^application\/(?:json|[^;\s/]+\+json)\s*(?:;.*)?$/i;

/**
 * GET or POST JSON at a user-supplied URL without letting it reach anything inside (SSRF, §23.1):
 * `https` only, the host must be on the caller's allowlist, it is resolved once and must resolve
 * only to public addresses, the connection goes to that address with the certificate checked for
 * the real host, redirects are never followed, and time and size are bounded. Resolves with the
 * parsed body for any 2xx `application/json` answer; everything else is a {@link PublicFetchError}.
 */
export async function fetchPublicJson(
  req: PublicFetchRequest,
  options: PublicFetchOptions = {},
): Promise<{ status: number; json: unknown }> {
  const url = parseUrl(req.url);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname))
    throw new PublicFetchError("invalid_url", "The URL must name a host, not an IP address");
  let host: string;
  try {
    host = normalizeEgressHost(hostname);
  } catch {
    throw new PublicFetchError("invalid_url", "The URL's host name is not valid");
  }
  if (!matchesHostPattern(host, req.allowHosts))
    throw new PublicFetchError("host_not_allowed", "The host is not on the allowlist");
  const body = req.method === "POST" ? (req.body ?? "") : undefined;
  if (body !== undefined && Buffer.byteLength(body) > (options.maxRequestBytes ?? 262_144))
    throw new PublicFetchError("too_large", "The request body is too large");

  const deadlineMs = options.deadlineMs ?? 10_000;
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new PublicFetchError("timeout", "The request timed out")),
      deadlineMs,
    );
  });
  try {
    const [address] = await Promise.race([
      resolvePublicAddresses(host, options.resolve).catch(() => {
        throw new PublicFetchError(
          "private_address",
          "The host does not resolve only to public addresses",
        );
      }),
      expired,
    ]);
    return await Promise.race([
      send(
        req,
        body,
        url,
        host,
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

function parseUrl(text: string): URL {
  const bad = (why: string) => new PublicFetchError("invalid_url", `The URL ${why}`);
  if (text.length > MAX_URL_LENGTH) throw bad("is too long");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw bad("is not valid");
  }
  if (url.protocol !== "https:") throw bad("must be https");
  if (url.username !== "" || url.password !== "") throw bad("must not carry credentials");
  if (url.port !== "" && url.port !== "443") throw bad("must use the default port");
  if (text.includes("#")) throw bad("must not have a fragment");
  return url;
}

function send(
  req: PublicFetchRequest,
  body: string | undefined,
  url: URL,
  hostname: string,
  address: string,
  options: PublicFetchOptions,
  remainingMs: number,
): Promise<{ status: number; json: unknown }> {
  const maxBytes = options.maxResponseBytes ?? 1_048_576;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers ?? {}))
    if (!OWN_HEADERS.has(name.toLowerCase())) headers[name] = value;
  headers["accept"] = "application/json";
  headers["host"] = url.host;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const fail = (error: PublicFetchError) => {
      clientReq.destroy();
      reject(error);
    };
    const clientReq = request(
      {
        host: address,
        port: options.port ?? 443,
        ...(options.ca ? { ca: options.ca } : {}),
        method: req.method,
        path: `${url.pathname}${url.search}`,
        servername: hostname,
        headers,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400)
          return fail(
            new PublicFetchError("redirect", "The host answered with a redirect", status),
          );
        if (status < 200 || status >= 300)
          return fail(new PublicFetchError("http_status", `The host answered ${status}`, status));
        if (!JSON_TYPE.test(String(res.headers["content-type"] ?? "")))
          return fail(new PublicFetchError("content_type", "The answer is not JSON", status));
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes)
            return fail(new PublicFetchError("too_large", "The answer is too large", status));
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            resolve({
              status,
              json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
            });
          } catch {
            reject(new PublicFetchError("invalid_json", "The answer is not valid JSON", status));
          }
        });
        res.on("error", () => reject(new PublicFetchError("network", "The connection failed")));
      },
    );
    // The overall deadline also destroys the socket, so nothing lingers once it has passed.
    const kill = setTimeout(() => clientReq.destroy(), remainingMs);
    clientReq.on("close", () => clearTimeout(kill));
    clientReq.on("error", () => reject(new PublicFetchError("network", "The connection failed")));
    clientReq.end(body);
  });
}
