import { lookup } from "node:dns/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrossoverError } from "@crossover/protocol";
import { git, GitError } from "./git.js";

/** What an upstream fetch needs to authenticate, from a {@link GitCredentialProvider}. */
export type GitCredential =
  { type: "bearer"; token: string } | { type: "basic"; username: string; password: string };

/**
 * Where a room's upstream credentials come from (§24.1). Public HTTPS repositories need none
 * (the default provider answers `null`); the GitHub App installation provider arrives with the
 * plugin runner. A credential is handed to Git through its environment for the one fetch and is
 * never stored, logged, put in an event or returned in a response.
 */
export interface GitCredentialProvider {
  credentialFor(url: URL): Promise<GitCredential | null>;
}

export const noCredentials: GitCredentialProvider = { credentialFor: async () => null };

/** A fetched upstream branch, ready to be read into the room repository. */
export interface FetchedUpstream {
  /** A Git repository (bare or not) holding the fetched commit. */
  repo: string;
  /** The ref in `repo` that names the tip. */
  ref: string;
  /** The tip commit, 40 or 64 hex characters. */
  sha: string;
  /** Delete whatever the fetch created. Safe to call twice. */
  cleanup(): Promise<void>;
}

/** The seam between `git.import` and the network (§24.1): tests fetch from a local fixture. */
export interface UpstreamFetcher {
  fetch(request: {
    url: string;
    branch: string;
    credential: GitCredential | null;
  }): Promise<FetchedUpstream>;
}

export const MAX_UPSTREAM_URL_LENGTH = 2048;

/** Branch names: what Git allows that is also safe to pass as an argument and a ref. */
export const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function validBranch(branch: string): boolean {
  return (
    BRANCH_PATTERN.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".") &&
    !branch.endsWith(".lock")
  );
}

/** Addresses a server must not be made to connect to on a user's say-so (SSRF). */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped (::ffff:10.0.0.1), which URL parsing also writes as ::ffff:a00:1.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const lo = parseInt(mappedHex[2]!, 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return (
      lower === "::" ||
      lower === "::1" ||
      /^f[cd]/.test(lower) || // unique local fc00::/7
      /^fe[89ab]/.test(lower) || // link-local fe80::/10
      lower.startsWith("ff") // multicast
    );
  }
  return true; // not an address at all: refuse
}

export type HostResolver = (host: string) => Promise<string[]>;

const resolveHost: HostResolver = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

/**
 * Check an upstream URL and return it parsed: `https` only, no credentials in it (they come
 * from the provider), the default port, and a host that is public, whether named or given as an
 * address. The check is best effort against DNS changing between this lookup and the fetch;
 * Git is also told to speak only HTTPS.
 */
export async function assertPublicHttpsUrl(
  value: string,
  resolve: HostResolver = resolveHost,
): Promise<URL> {
  const invalid = (reason: string, message: string) =>
    new CrossoverError("VALIDATION", message, { details: { reason } });
  if (value.length > MAX_UPSTREAM_URL_LENGTH) throw invalid("url", "The upstream URL is too long");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("url", "The upstream URL isn't a valid URL");
  }
  if (url.protocol !== "https:") throw invalid("url_scheme", "The upstream URL must be https");
  if (url.username !== "" || url.password !== "") {
    throw invalid("url_credentials", "The upstream URL must not contain credentials");
  }
  if (url.port !== "" && url.port !== "443") {
    throw invalid("url_port", "The upstream URL must use the default HTTPS port");
  }
  if (url.search !== "" || url.hash !== "") {
    throw invalid("url_query", "The upstream URL must not have a query or fragment");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0) throw invalid("url_host", "The upstream host doesn't resolve");
  if (addresses.some(isPrivateAddress)) {
    throw invalid("url_host", "The upstream host isn't a public address");
  }
  return url;
}

/** Hide a secret in text that is about to leave this module (an error message, say). */
export function scrub(text: string, credential: GitCredential | null): string {
  if (!credential) return text;
  const secrets =
    credential.type === "bearer" ? [credential.token] : [credential.password, credential.username];
  let out = text;
  for (const secret of secrets) if (secret.length > 0) out = out.split(secret).join("***");
  return out;
}

export interface HttpsGitFetcherOptions {
  /** Where the temporary clone goes. Default: the OS temp directory. */
  tmpDir?: string;
  /** Default 120 000 ms. */
  timeoutMs?: number;
  resolve?: HostResolver;
  /** The Git runner; tests replace it to see exactly what would be run. */
  run?: typeof git;
}

/**
 * Fetch a branch over HTTPS with a shallow, single-branch clone into a temporary directory
 * (§24.1). The URL is checked first ({@link assertPublicHttpsUrl}). Git is limited to the
 * `https` protocol, never prompts, and gets any credential through its environment as an
 * `Authorization` header, so it appears in no command line, no URL and no error text.
 */
export class HttpsGitFetcher implements UpstreamFetcher {
  private readonly run: typeof git;
  constructor(private readonly options: HttpsGitFetcherOptions = {}) {
    this.run = options.run ?? git;
  }

  async fetch(request: { url: string; branch: string; credential: GitCredential | null }) {
    const url = await assertPublicHttpsUrl(request.url, this.options.resolve);
    if (!validBranch(request.branch)) {
      throw new CrossoverError("VALIDATION", "The branch name isn't allowed", {
        details: { reason: "branch" },
      });
    }
    const dir = await mkdtemp(join(this.options.tmpDir ?? tmpdir(), "crossover-import-"));
    const repo = join(dir, "repo");
    const cleanup = () => rm(dir, { recursive: true, force: true });
    const env: NodeJS.ProcessEnv = {
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "https",
      GIT_CONFIG_NOSYSTEM: "1",
      // No user-level config of the host (a url.insteadOf, a credential helper) reaches the fetch.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ASKPASS: "true",
      // A redirect could send a validated public URL to a private host, or carry the credential
      // to another one: refuse them all.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.followRedirects",
      GIT_CONFIG_VALUE_0: "false",
    };
    const credential = request.credential;
    if (credential) {
      const header =
        credential.type === "bearer"
          ? `Bearer ${credential.token}`
          : `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`;
      env["GIT_CONFIG_COUNT"] = "2";
      env["GIT_CONFIG_KEY_1"] = "http.extraHeader";
      env["GIT_CONFIG_VALUE_1"] = `Authorization: ${header}`;
    }
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    try {
      await this.run(
        [
          "clone",
          "--depth=1",
          "--bare",
          "--single-branch",
          "--no-tags",
          "--template=",
          `--branch=${request.branch}`,
          "--",
          url.href,
          repo,
        ],
        { cwd: dir, env, timeoutMs },
      );
      const sha = (
        await this.run(["rev-parse", "HEAD"], { gitDir: repo, timeoutMs: 10_000 })
      ).stdout.trim();
      return {
        repo,
        ref: "HEAD",
        sha,
        cleanup,
      };
    } catch (error) {
      await cleanup();
      const detail = error instanceof GitError ? error.stderr : String(error);
      throw new CrossoverError("VALIDATION", "Couldn't fetch the upstream branch", {
        details: {
          reason:
            error instanceof GitError && error.timedOut
              ? "upstream_timeout"
              : "upstream_unavailable",
          // The first line of Git's complaint, with any secret and the URL's own text removed.
          message: scrub(detail, credential).split("\n")[0]?.slice(0, 300) ?? "",
        },
      });
    }
  }
}
