import { normalizeGitHubRepository } from "@crossover/github-api";
import type { ToolDefinition, ToolRegistry } from "@crossover/kernel";
import { z } from "zod";

const repositorySchema = z
  .string()
  .min(3)
  .max(140)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9_-])?$/,
  );
const branchSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes("..") && !value.includes("//") && !value.endsWith("/"))
  .refine((value) => !value.endsWith(".") && !value.endsWith(".lock") && !value.includes("@{"));

export const githubReadRepositoryParams = z.strictObject({
  repo: repositorySchema,
  path: z.string().min(1).max(1_024).optional(),
  ref: z.string().min(1).max(255).optional(),
});

export const githubCreatePullRequestParams = z.strictObject({
  repo: repositorySchema,
  head: branchSchema,
  base: branchSchema,
  title: z.string().trim().min(1).max(256),
  body: z.string().max(4_000).optional(),
  draft: z.boolean().optional(),
});

const execution = (
  image: string,
  permissions: Readonly<Record<string, "read" | "write">>,
  maxOutputBytes?: number,
) => ({
  image,
  command: ["node", "--use-env-proxy", "/app/plugins/github/worker.mjs"],
  egressHosts: ["api.github.com"],
  integrations: [{ provider: "github", permissions }],
  ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
});

export function registerGitHubTools(registry: ToolRegistry, image: string): void {
  const definitions: ToolDefinition[] = [
    {
      name: "github.read_repository",
      description: "Read metadata, files, or a directory from a connected GitHub repository.",
      capability: "github.read_repository",
      tier: 0,
      input: githubReadRepositoryParams,
      scope: (args) => (args as z.infer<typeof githubReadRepositoryParams>).repo,
      normalizeScope: normalizeGitHubRepository,
      idempotent: true,
      execution: execution(image, { contents: "read", metadata: "read" }, 256 * 1024),
    },
    {
      name: "github.create_pull_request",
      description: "Open or return the pull request for a repository branch and base.",
      capability: "github.create_pull_request",
      tier: 2,
      input: githubCreatePullRequestParams,
      scope: (args) => (args as z.infer<typeof githubCreatePullRequestParams>).repo,
      normalizeScope: normalizeGitHubRepository,
      idempotent: true,
      execution: execution(image, { contents: "read", pull_requests: "write" }),
    },
  ];
  for (const definition of definitions)
    if (!registry.get(definition.name)) registry.register(definition);
}
