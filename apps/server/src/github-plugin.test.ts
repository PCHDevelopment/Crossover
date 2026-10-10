import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ToolRegistry, capabilityFor, scopeOf } from "@crossover/kernel";
import {
  githubCreatePullRequestParams,
  githubReadRepositoryParams,
  registerGitHubTools,
} from "./github-plugin.js";

describe("GitHub worker and tool scopes", () => {
  it("runs the worker handler against an injected client and refuses arguments outside its scope", () => {
    const workerUrl = pathToFileURL(
      fileURLToPath(new URL("../../../plugins/github/worker.mjs", import.meta.url)),
    ).href;
    const clientUrl = pathToFileURL(
      fileURLToPath(new URL("../../../packages/github-api/dist/index.js", import.meta.url)),
    ).href;
    const run = (invocation: unknown) => {
      const script = `
        const { handleGitHubInvocation } = await import(${JSON.stringify(workerUrl)});
        const { createGitHubApiClient } = await import(${JSON.stringify(clientUrl)});
        let calls = 0;
        const client = createGitHubApiClient({ baseUrl: "https://api.github.test", fetcher: async () => {
          calls += 1;
          return Response.json({ full_name: "acme/widgets", default_branch: "main", private: false, description: "recorded" });
        } });
        try {
          const result = await handleGitHubInvocation(${JSON.stringify(invocation)}, { token: "fixture-token", client });
          process.stdout.write(JSON.stringify({ result, calls }));
        } catch (error) {
          process.stdout.write(JSON.stringify({ error: { code: error.code, message: error.message }, calls }));
        }
      `;
      return JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }),
      );
    };

    expect(
      run({
        tool: "github.read_repository",
        scope: "Acme/Widgets",
        args: { repo: "acme/widgets" },
      }),
    ).toEqual({
      result: {
        type: "repository",
        full_name: "acme/widgets",
        default_branch: "main",
        private: false,
        description: "recorded",
        html_url: "https://github.com/acme/widgets",
      },
      calls: 1,
    });
    expect(
      run({
        tool: "github.read_repository",
        scope: "acme/widgets",
        args: { repo: "acme/other" },
      }),
    ).toMatchObject({ error: { code: "forbidden" }, calls: 0 });
  });

  it("canonicalizes repository grants and declares fine-grained tool permissions", () => {
    const image = `registry.example/crossover-github-plugin@sha256:${"a".repeat(64)}`;
    const registry = new ToolRegistry({
      tierOf: (capability) => (capability.endsWith("pull_request") ? 2 : 0),
    });
    registerGitHubTools(registry, image);
    const read = registry.get("github.read_repository")!;
    const create = registry.get("github.create_pull_request")!;
    const readArgs = githubReadRepositoryParams.parse({ repo: "Acme/Widgets", path: "README.md" });
    const createArgs = githubCreatePullRequestParams.parse({
      repo: "Acme/Widgets",
      head: "room/change",
      base: "main",
      title: "Change",
    });

    expect(scopeOf(read, readArgs)).toBe("acme/widgets");
    expect(capabilityFor(create, createArgs)).toBe("github.create_pull_request:acme/widgets");
    expect(read.execution?.integrations).toEqual([
      { provider: "github", permissions: { contents: "read", metadata: "read" } },
    ]);
    expect(create.execution?.integrations).toEqual([
      { provider: "github", permissions: { contents: "read", pull_requests: "write" } },
    ]);
    expect(create.execution?.egressHosts).toEqual(["api.github.com"]);
    expect(create.execution?.image).toBe(image);
    expect(read.execution?.maxOutputBytes).toBe(256 * 1024);
    registerGitHubTools(registry, image);
    expect(registry.list().map((tool) => tool.name)).toEqual([
      "github.create_pull_request",
      "github.read_repository",
    ]);
  });
});
