import { createGitHubApiClient, GitHubApiError, type GitHubApiClient } from "@crossover/github-api";
import { CrossoverError } from "@crossover/protocol";
import {
  githubRepositoryFromUrl,
  type GitCredential,
  type PullRequestProvider,
} from "@crossover/workspace";

export class GitHubPullRequestProvider implements PullRequestProvider {
  constructor(private readonly client: GitHubApiClient = createGitHubApiClient()) {}

  async create(request: {
    url: string;
    head: string;
    base: string;
    title: string;
    body: string;
    credential: GitCredential | null;
  }): Promise<{ url: string; number: number }> {
    const repository = githubRepositoryFromUrl(request.url);
    if (!request.credential || request.credential.type !== "bearer") {
      throw new CrossoverError(
        "PROVIDER_UNAVAILABLE",
        "GitHub pull request credentials are unavailable",
      );
    }
    try {
      const result = await this.client.createPullRequest({
        repository,
        head: request.head,
        base: request.base,
        title: request.title,
        body: request.body,
        token: request.credential.token,
      });
      return { url: result.url, number: result.number };
    } catch (error) {
      if (!(error instanceof GitHubApiError))
        throw new CrossoverError("PROVIDER_UNAVAILABLE", "GitHub couldn't open the pull request");
      if (error.code === "not_found") throw new CrossoverError("NOT_FOUND", error.message);
      if (error.code === "forbidden") throw new CrossoverError("FORBIDDEN", error.message);
      if (error.code === "validation") throw new CrossoverError("VALIDATION", error.message);
      if (error.code === "rate_limited") {
        throw new CrossoverError("RATE_LIMITED", error.message, {
          retryable: true,
          ...(error.retry_after === undefined
            ? {}
            : { details: { retry_after: error.retry_after } }),
        });
      }
      throw new CrossoverError("PROVIDER_UNAVAILABLE", error.message, {
        retryable: error.retryable,
      });
    }
  }
}
