import { CrossoverError } from "@crossover/protocol";
import { describe, expect, it } from "vitest";
import { GitError, type git } from "./git.js";
import {
  assertPublicHttpsUrl,
  HttpsGitFetcher,
  isPrivateAddress,
  scrub,
  validBranch,
} from "./upstream.js";

const PUBLIC = async () => ["93.184.216.34"];
const refusal = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  return (err as CrossoverError).details?.reason as string;
};

describe("assertPublicHttpsUrl", () => {
  it("accepts a plain https URL on a public host", async () => {
    const url = await assertPublicHttpsUrl("https://github.com/acme/widgets.git", PUBLIC);
    expect(url.host).toBe("github.com");
    expect((await assertPublicHttpsUrl("https://github.com:443/a/b", PUBLIC)).hostname).toBe(
      "github.com",
    );
  });

  it("refuses other schemes, credentials, ports, queries and bad URLs", async () => {
    const cases: [string, string][] = [
      ["http://github.com/a/b", "url_scheme"],
      ["ssh://git@github.com/a/b", "url_scheme"],
      ["file:///etc/passwd", "url_scheme"],
      ["git://github.com/a/b", "url_scheme"],
      ["https://user@github.com/a/b", "url_credentials"],
      ["https://user:pw@github.com/a/b", "url_credentials"],
      ["https://github.com:8443/a/b", "url_port"],
      ["https://github.com/a/b?token=x", "url_query"],
      ["https://github.com/a/b#frag", "url_query"],
      ["not a url", "url"],
      [`https://github.com/${"a".repeat(3000)}`, "url"],
    ];
    for (const [value, reason] of cases) {
      expect(await refusal(assertPublicHttpsUrl(value, PUBLIC)), value).toBe(reason);
    }
  });

  it("refuses hosts that are, or resolve to, private addresses (SSRF)", async () => {
    for (const host of [
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "[::1]",
      "[fd00::1]",
      "[::ffff:10.0.0.1]",
    ]) {
      expect(await refusal(assertPublicHttpsUrl(`https://${host}/a/b`, PUBLIC)), host).toBe(
        "url_host",
      );
    }
    const resolvesPrivate = async () => ["93.184.216.34", "10.1.2.3"];
    expect(
      await refusal(assertPublicHttpsUrl("https://evil.example.com/a/b", resolvesPrivate)),
    ).toBe("url_host");
    const nothing = async () => {
      throw new Error("ENOTFOUND");
    };
    expect(await refusal(assertPublicHttpsUrl("https://nope.example.com/a/b", nothing))).toBe(
      "url_host",
    );
    expect(
      await refusal(assertPublicHttpsUrl("https://localhost/a/b", async () => ["127.0.0.1"])),
    ).toBe("url_host");
  });
});

describe("isPrivateAddress", () => {
  it("knows the private, loopback, link-local and special ranges", () => {
    for (const a of [
      "0.0.0.0",
      "10.255.255.255",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "::",
      "::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of [
      "8.8.8.8",
      "93.184.216.34",
      "172.15.0.1",
      "172.32.0.1",
      "100.63.0.1",
      "2606:4700:4700::1111",
    ]) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });
});

describe("validBranch", () => {
  it("allows ordinary branch names and refuses anything unsafe as an argument or a ref", () => {
    for (const b of ["main", "release/1.2", "feature/x_y-z", "v1.0.0"])
      expect(validBranch(b), b).toBe(true);
    for (const b of [
      "",
      "-rf",
      "--upload-pack=x",
      "a..b",
      "a b",
      "a//b",
      "a/",
      "x.lock",
      "x.",
      "a;b",
      "$(x)",
      "a\nb",
      "é",
    ]) {
      expect(validBranch(b), JSON.stringify(b)).toBe(false);
    }
  });
});

describe("scrub", () => {
  it("removes a credential's secrets from text, and leaves text alone without one", () => {
    expect(scrub("fatal: token abc123 rejected", { type: "bearer", token: "abc123" })).toBe(
      "fatal: token *** rejected",
    );
    expect(scrub("u=bob p=hunter2", { type: "basic", username: "bob", password: "hunter2" })).toBe(
      "u=*** p=***",
    );
    expect(scrub("plain", null)).toBe("plain");
  });
});

describe("HttpsGitFetcher", () => {
  interface Call {
    args: readonly string[];
    cwd: string | undefined;
    env: NodeJS.ProcessEnv | undefined;
  }
  const recorder = (fail?: GitError) => {
    const calls: Call[] = [];
    const run = (async (
      args: readonly string[],
      options: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ args, cwd: options.cwd, env: options.env });
      if (fail && args[0] === "clone") throw fail;
      return { stdout: "a".repeat(40) + "\n", stderr: "" };
    }) as unknown as typeof git;
    return { calls, run };
  };

  it("clones shallow and single-branch over https only, never prompting, with the URL clean", async () => {
    const { calls, run } = recorder();
    const fetcher = new HttpsGitFetcher({ resolve: PUBLIC, run });
    const out = await fetcher.fetch({
      url: "https://github.com/acme/widgets",
      branch: "main",
      credential: null,
    });
    const clone = calls[0]!;
    expect(clone.args).toEqual(
      expect.arrayContaining([
        "clone",
        "--depth=1",
        "--bare",
        "--single-branch",
        "--no-tags",
        "--branch=main",
        "--",
      ]),
    );
    expect(clone.args).toContain("https://github.com/acme/widgets");
    expect(clone.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https" });
    // The host's own Git config is out of it, and a redirect is never followed (the URL was
    // vetted; where a redirect leads wasn't).
    expect(clone.env).toMatchObject({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.followRedirects",
      GIT_CONFIG_VALUE_0: "false",
    });
    expect(clone.env).not.toHaveProperty("GIT_CONFIG_KEY_1");
    expect(out.sha).toBe("a".repeat(40));
    await out.cleanup();
    await out.cleanup(); // twice is fine
  });

  it("passes a credential through the environment only: not in any argument, and never in the URL", async () => {
    const { calls, run } = recorder();
    const fetcher = new HttpsGitFetcher({ resolve: PUBLIC, run });
    const out = await fetcher.fetch({
      url: "https://github.com/acme/widgets",
      branch: "main",
      credential: { type: "bearer", token: "tok_secret" },
    });
    const clone = calls[0]!;
    expect(clone.env).toMatchObject({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.followRedirects",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "http.extraHeader",
      GIT_CONFIG_VALUE_1: "Authorization: Bearer tok_secret",
    });
    for (const call of calls) expect(call.args.join(" ")).not.toContain("tok_secret");
    await out.cleanup();

    const basic = recorder();
    const out2 = await new HttpsGitFetcher({ resolve: PUBLIC, run: basic.run }).fetch({
      url: "https://github.com/acme/widgets",
      branch: "main",
      credential: { type: "basic", username: "bob", password: "pw" },
    });
    expect(basic.calls[0]!.env!["GIT_CONFIG_VALUE_1"]).toBe(
      `Authorization: Basic ${Buffer.from("bob:pw").toString("base64")}`,
    );
    await out2.cleanup();
  });

  it("a failed clone reports Git's first line with the secret scrubbed, and cleans up", async () => {
    const { run } = recorder(
      new GitError("clone failed", 128, "fatal: bad token tok_secret for repo\nmore", false),
    );
    const fetcher = new HttpsGitFetcher({ resolve: PUBLIC, run });
    const err = await fetcher
      .fetch({
        url: "https://github.com/a/b",
        branch: "main",
        credential: { type: "bearer", token: "tok_secret" },
      })
      .then(
        () => undefined,
        (e: unknown) => e as CrossoverError,
      );
    expect(err).toBeInstanceOf(CrossoverError);
    expect(err!.details).toMatchObject({
      reason: "upstream_unavailable",
      message: "fatal: bad token *** for repo",
    });
    expect(JSON.stringify(err!.details)).not.toContain("tok_secret");
  });

  it("a timeout is its own reason; a bad URL or branch is refused before Git runs", async () => {
    const timeout = new GitError("slow", null, "", true);
    const t = recorder(timeout);
    const err = await new HttpsGitFetcher({ resolve: PUBLIC, run: t.run })
      .fetch({ url: "https://github.com/a/b", branch: "main", credential: null })
      .catch((e: unknown) => e as CrossoverError);
    expect((err as CrossoverError).details).toMatchObject({ reason: "upstream_timeout" });

    const r = recorder();
    const fetcher = new HttpsGitFetcher({ resolve: PUBLIC, run: r.run });
    expect(
      await refusal(
        fetcher.fetch({ url: "http://github.com/a/b", branch: "main", credential: null }),
      ),
    ).toBe("url_scheme");
    expect(
      await refusal(
        fetcher.fetch({
          url: "https://github.com/a/b",
          branch: "--upload-pack=x",
          credential: null,
        }),
      ),
    ).toBe("branch");
    expect(r.calls).toEqual([]);
  });
});
