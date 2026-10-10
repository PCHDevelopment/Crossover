import { describe, expect, it } from "vitest";
import { createGitHubApiClient, GitHubApiError } from "@crossover/github-api";
import { CrossoverError } from "@crossover/protocol";
import { githubRepositoryFromUrl } from "@crossover/workspace";
import { GitHubPullRequestProvider } from "./github-pull-request.js";

const TOKEN = "ghs_recorded_installation_token";

function jsonResponse(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(value, { status, ...(headers ? { headers } : {}) });
}

describe("GitHub API contract", () => {
  it("reads metadata with a non-redirecting authenticated request and drops extra fields", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createGitHubApiClient({
      baseUrl: "https://api.github.test",
      fetcher: async (input, init) => {
        requests.push({ url: String(input), ...(init ? { init } : {}) });
        return jsonResponse({
          id: 7,
          full_name: "Acme/Widgets",
          default_branch: "main",
          private: true,
          description: "recorded fixture",
          token: TOKEN,
          html_url: "https://github.com/acme/widgets",
        });
      },
    });

    const result = await client.readRepository({ repository: "Acme/Widgets", token: TOKEN });

    expect(result).toEqual({
      type: "repository",
      full_name: "Acme/Widgets",
      default_branch: "main",
      private: true,
      description: "recorded fixture",
      html_url: "https://github.com/acme/widgets",
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(requests[0]?.url).toBe("https://api.github.test/repos/acme/widgets");
    expect(requests[0]?.init).toMatchObject({
      redirect: "error",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-github-api-version": "2022-11-28",
      },
    });
  });

  it("returns directory entries, decodes UTF-8 files, and enforces the 128 KiB inline boundary", async () => {
    const calls: string[] = [];
    const client = createGitHubApiClient({
      baseUrl: "https://api.github.test/v3/",
      fetcher: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/contents/docs"))
          return jsonResponse([
            { name: "guide.md", path: "docs/guide.md", type: "file", size: 8 },
            { name: "nested", path: "docs/nested", type: "dir", size: 0 },
          ]);
        if (url.includes("/contents/README.md"))
          return jsonResponse({
            type: "file",
            path: "README.md",
            sha: "abc123",
            size: 8,
            content: Buffer.from("read me\n").toString("base64"),
            encoding: "base64",
          });
        const overLimit = url.includes("just-over");
        const size = overLimit ? 128 * 1024 + 1 : 128 * 1024 - 1;
        return jsonResponse({
          type: "file",
          path: overLimit
            ? "just-over.txt"
            : url.includes("escaped")
              ? "escaped.txt"
              : "just-under.txt",
          sha: "boundary-sha",
          size,
          content: Buffer.alloc(size, url.includes("escaped") ? 0x0a : 0x61).toString("base64"),
        });
      },
    });

    await expect(
      client.readRepository({ repository: "acme/widgets", path: "docs", token: TOKEN }),
    ).resolves.toEqual({
      type: "dir",
      path: "docs",
      entries: [
        { name: "guide.md", path: "docs/guide.md", type: "file", size: 8 },
        { name: "nested", path: "docs/nested", type: "dir", size: 0 },
      ],
      truncated: false,
    });
    await expect(
      client.readRepository({ repository: "acme/widgets", path: "README.md", token: TOKEN }),
    ).resolves.toMatchObject({
      type: "file",
      path: "README.md",
      encoding: "utf8",
      content: "read me\n",
    });
    const justUnder = await client.readRepository({
      repository: "acme/widgets",
      path: "just-under",
      token: TOKEN,
    });
    expect(justUnder).toMatchObject({
      type: "file",
      path: "just-under.txt",
      size: 128 * 1024 - 1,
      encoding: "utf8",
      content: "a".repeat(128 * 1024 - 1),
    });
    expect(Buffer.byteLength(JSON.stringify(justUnder))).toBeLessThan(256 * 1024);
    const escaped = await client.readRepository({
      repository: "acme/widgets",
      path: "escaped",
      token: TOKEN,
    });
    expect(escaped).toMatchObject({
      type: "file",
      path: "escaped.txt",
      encoding: "base64",
      content: Buffer.alloc(128 * 1024 - 1, 0x0a).toString("base64"),
    });
    expect(Buffer.byteLength(JSON.stringify(escaped))).toBeLessThan(256 * 1024);
    await expect(
      client.readRepository({ repository: "acme/widgets", path: "just-over", token: TOKEN }),
    ).resolves.toEqual({
      type: "file",
      too_large: true,
      path: "just-over.txt",
      sha: "boundary-sha",
      size: 128 * 1024 + 1,
    });
    expect(calls).toHaveLength(5);
  });

  it("caps large directories at 1,000 entries and reports truncation from the repository tree", async () => {
    const requests: string[] = [];
    const client = createGitHubApiClient({
      baseUrl: "https://api.github.test",
      fetcher: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("/contents/docs"))
          return jsonResponse(
            Array.from({ length: 1_000 }, (_, index) => ({
              name: `file-${index}`,
              path: `docs/file-${index}`,
              type: "file",
              size: 1,
            })),
          );
        return jsonResponse({
          truncated: false,
          tree: Array.from({ length: 1_001 }, (_, index) => ({
            path: `docs/file-${index}`,
            type: "blob",
          })),
        });
      },
    });

    const result = await client.readRepository({
      repository: "acme/widgets",
      path: "docs",
      ref: "main",
      token: TOKEN,
    });
    expect(result).toMatchObject({ type: "dir", path: "docs", truncated: true });
    expect(result.type === "dir" && result.entries).toHaveLength(1_000);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("/git/trees/main?recursive=1");
  });

  it("returns an existing open pull request for the same head and base", async () => {
    const requests: string[] = [];
    const client = createGitHubApiClient({
      baseUrl: "https://api.github.test",
      fetcher: async (input) => {
        requests.push(String(input));
        return jsonResponse([
          {
            number: 11,
            state: "open",
            head: { ref: "room/feature", repo: { full_name: "acme/widgets" } },
            base: { ref: "main" },
          },
          {
            number: 12,
            state: "open",
            head: { ref: "room/feature", repo: { full_name: "acme/widgets" } },
            base: { ref: "develop" },
          },
        ]);
      },
    });

    const result = await client.createPullRequest({
      repository: "Acme/Widgets",
      head: "room/feature",
      base: "main",
      title: "Feature",
      body: "Created by the room",
      token: TOKEN,
    });

    expect(result).toEqual({
      url: "https://github.com/acme/widgets/pull/11",
      number: 11,
      created: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("head=acme%3Aroom%2Ffeature");
    expect(requests[0]).toContain("base=main");
  });

  it("creates a pull request and recovers the duplicate-open race", async () => {
    let lookups = 0;
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createGitHubApiClient({
      baseUrl: "https://api.github.test",
      fetcher: async (input, init) => {
        const url = String(input);
        requests.push({ url, ...(init ? { init } : {}) });
        if (url.includes("/pulls?")) {
          lookups += 1;
          return lookups === 1
            ? jsonResponse([])
            : jsonResponse([
                {
                  number: 29,
                  state: "open",
                  head: { ref: "room/change", repo: { full_name: "acme/widgets" } },
                  base: { ref: "main" },
                },
              ]);
        }
        return jsonResponse({ message: `Validation Failed ${TOKEN}` }, 422);
      },
    });

    const result = await client.createPullRequest({
      repository: "acme/widgets",
      head: "room/change",
      base: "main",
      title: "Change",
      body: "Body",
      draft: true,
      token: TOKEN,
    });

    expect(result).toEqual({
      url: "https://github.com/acme/widgets/pull/29",
      number: 29,
      created: false,
    });
    expect(requests.map(({ init }) => init?.method ?? "GET")).toEqual(["GET", "POST", "GET"]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      head: "room/change",
      base: "main",
      title: "Change",
      body: "Body",
      draft: true,
    });
  });

  it("maps errors to stable codes without returning GitHub bodies or credentials", async () => {
    const client = createGitHubApiClient({
      baseUrl: "https://api.github.test",
      fetcher: async () =>
        jsonResponse({ message: `token ${TOKEN}` }, 429, { "retry-after": "12" }),
    });
    const error = await client
      .readRepository({ repository: "acme/widgets", token: TOKEN })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retry_after: 12,
      message: "GitHub rate limit reached",
    });
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });
});

describe("GitHub pull request provider", () => {
  it("accepts GitHub HTTPS repository URLs and uses the typed API client for export", async () => {
    expect(githubRepositoryFromUrl("https://github.com/Acme/Widgets.git")).toBe("acme/widgets");
    expect(() => githubRepositoryFromUrl("https://github.com/acme/widgets/tree/main")).toThrow(
      CrossoverError,
    );
    expect(() => githubRepositoryFromUrl("https://user:secret@github.com/acme/widgets")).toThrow(
      CrossoverError,
    );

    const client = createGitHubApiClient({
      baseUrl: "https://api.github.test",
      fetcher: async (input, init) => {
        if (String(input).includes("/pulls?")) return jsonResponse([]);
        expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
        return jsonResponse({ number: 31 });
      },
    });
    const provider = new GitHubPullRequestProvider(client);
    await expect(
      provider.create({
        url: "https://github.com/acme/widgets.git",
        head: "room/change",
        base: "main",
        title: "Change",
        body: "Body",
        credential: { type: "bearer", token: TOKEN },
      }),
    ).resolves.toEqual({ url: "https://github.com/acme/widgets/pull/31", number: 31 });
    await expect(
      provider.create({
        url: "https://github.com/acme/widgets",
        head: "room/change",
        base: "main",
        title: "Change",
        body: "Body",
        credential: null,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});
