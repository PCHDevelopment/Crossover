import process, { stdin, stdout } from "node:process";
import { Buffer } from "node:buffer";
import { pathToFileURL } from "node:url";
import {
  createGitHubApiClient,
  GitHubApiError,
  normalizeGitHubRepository,
} from "../../packages/github-api/dist/index.js";

const MAX_REQUEST_BYTES = 64 * 1024;

/** Execute only the repository scope already authorized by the platform. */
export async function handleGitHubInvocation(
  invocation,
  { token, client = createGitHubApiClient() } = {},
) {
  if (!invocation || typeof invocation !== "object" || typeof invocation.scope !== "string")
    throw new GitHubApiError("validation", "GitHub invocation is invalid");
  if (typeof token !== "string" || token.length === 0)
    throw new GitHubApiError("forbidden", "GitHub credential is unavailable");
  const repository = normalizeGitHubRepository(invocation.scope);
  const args = invocation.args;
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new GitHubApiError("validation", "GitHub arguments are invalid");
  let requestedRepository;
  try {
    requestedRepository = normalizeGitHubRepository(args.repo);
  } catch {
    throw new GitHubApiError(
      "forbidden",
      "The requested repository is outside the authorized scope",
    );
  }
  if (requestedRepository !== repository)
    throw new GitHubApiError(
      "forbidden",
      "The requested repository is outside the authorized scope",
    );

  if (invocation.tool === "github.read_repository") {
    return client.readRepository({
      repository,
      ...(typeof args.path === "string" ? { path: args.path } : {}),
      ...(typeof args.ref === "string" ? { ref: args.ref } : {}),
      token,
    });
  }
  if (invocation.tool === "github.create_pull_request") {
    return client.createPullRequest({
      repository,
      head: args.head,
      base: args.base,
      title: args.title,
      body: typeof args.body === "string" ? args.body : "",
      draft: args.draft === true,
      token,
    });
  }
  throw new GitHubApiError("validation", "GitHub tool is not registered");
}

async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES)
      throw new GitHubApiError("validation", "GitHub request exceeds the size limit");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GitHubApiError("validation", "GitHub request is invalid");
  }
}

async function main() {
  try {
    const { invocation } = await readRequest();
    const result = await handleGitHubInvocation(invocation, { token: process.env.GITHUB_TOKEN });
    stdout.write(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    const failure =
      error instanceof GitHubApiError
        ? error
        : new GitHubApiError("unavailable", "GitHub plugin failed", { retryable: true });
    stdout.write(
      `${JSON.stringify({
        error: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          ...(failure.retry_after === undefined ? {} : { retry_after: failure.retry_after }),
        },
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
