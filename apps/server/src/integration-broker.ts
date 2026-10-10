import { sign } from "node:crypto";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import type { Pool } from "@crossover/db";
import {
  readConnectedIntegrationSecretConfig,
  type AwsRoleVerifier,
  type GitHubConnectionVerifier,
  type SecretStore,
  type ToolExecutionSpec,
  type ToolIntegrationRequirement,
  type ToolInvocation,
} from "@crossover/kernel";
import type { PluginCredentialLease } from "./plugin-runner.js";
import type { ServerConfig } from "./config.js";

type GitHubAppCredentials = NonNullable<ServerConfig["githubApp"]>;

export interface AssumeRoleInput {
  room_id: string;
  role_arn: string;
  external_id: string;
  invocation_id?: string;
}

type AssumeRoleOutput = Record<string, string | undefined>;

export interface IntegrationCredentialBrokerOptions {
  pool: Pool;
  secretStore: SecretStore;
  github?: GitHubAppCredentials;
  assumeRole?: (input: AssumeRoleInput) => Promise<AssumeRoleOutput>;
  fetcher?: typeof fetch;
}

const API = "https://api.github.com";
const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};

export class IntegrationCredentialBroker {
  private readonly fetcher: typeof fetch;
  private readonly assumeRole: (input: AssumeRoleInput) => Promise<AssumeRoleOutput>;

  constructor(private readonly options: IntegrationCredentialBrokerOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.assumeRole = options.assumeRole ?? assumeAwsRole;
  }

  readonly verifyAwsRole: AwsRoleVerifier = async ({ room_id, role_arn, external_id }) => {
    const credentials = await this.assumeRole({ room_id, role_arn, external_id });
    return {
      connected: Boolean(
        credentials.accessKeyId && credentials.secretAccessKey && credentials.sessionToken,
      ),
    };
  };

  readonly verifyGitHubConnection: GitHubConnectionVerifier = async (input) => {
    const app = this.options.github;
    if (!app) throw new Error("GitHub integration is unavailable");
    const requested = input.repositories.map((name) => name.toLowerCase());
    if (new Set(requested).size !== requested.length)
      throw new Error("Invalid repository selection");

    const token = await this.exchangeCode(app, input.code);
    try {
      const installations = await this.githubPages<{ id: number }>(
        "/user/installations?per_page=100",
        token,
        "installations",
      );
      if (!installations.some(({ id }) => id === input.installation_id))
        throw new Error("Installation is not controlled by the authorizing user");
      // This user-token endpoint returns only repositories the authorizing user can access.
      const available = await this.githubPages<{ id: number; full_name: string }>(
        `/user/installations/${input.installation_id}/repositories?per_page=100`,
        token,
        "repositories",
      );
      const byName = new Map(
        available.map((repository) => [repository.full_name.toLowerCase(), repository]),
      );
      const repository_ids = requested.map((name) => {
        const repository = byName.get(name);
        if (!repository || !Number.isSafeInteger(repository.id) || repository.id <= 0)
          throw new Error("Repository is not accessible through this installation");
        return String(repository.id);
      });
      return { repository_ids };
    } finally {
      await this.revokeOAuthToken(app, token);
    }
  };

  async credentialsFor(
    invocation: ToolInvocation,
    execution: ToolExecutionSpec,
  ): Promise<PluginCredentialLease> {
    const environment: Record<string, string> = {};
    const revokers: Array<() => Promise<void>> = [];
    try {
      for (const requirement of execution.integrations ?? []) {
        const { configuration: config } = await readConnectedIntegrationSecretConfig(
          this.options.pool,
          this.options.secretStore,
          invocation.room_id,
          requirement.provider,
        );
        if (requirement.provider === "aws") {
          const roleArn = config.role_arn;
          const externalId = config.external_id;
          if (!roleArn || !externalId) throw new Error("AWS integration configuration is invalid");
          const credentials = await this.assumeRole({
            room_id: invocation.room_id,
            role_arn: roleArn,
            external_id: externalId,
            invocation_id: invocation.invocation_id,
          });
          if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken)
            throw new Error("AWS credentials were not returned");
          environment.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
          environment.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
          environment.AWS_SESSION_TOKEN = credentials.sessionToken;
        } else if (requirement.provider === "github") {
          const lease = await this.mintGitHubToken(invocation, requirement, config);
          environment.GITHUB_TOKEN = lease.token;
          revokers.push(lease.revoke);
        } else if (requirement.provider.startsWith("oauth:")) {
          const name = requirement.provider.slice("oauth:".length).toUpperCase();
          const token = config.access_token;
          if (!token) throw new Error("OAuth integration configuration is invalid");
          environment[`OAUTH_${name}_TOKEN`] = token;
        }
      }
    } catch {
      await Promise.allSettled(revokers.map((revoke) => revoke()));
      throw new Error("Integration credentials are unavailable");
    }

    return {
      environment: Object.freeze(environment),
      revoke: async () => {
        const outcomes = await Promise.allSettled(revokers.map((revoke) => revoke()));
        if (outcomes.some((outcome) => outcome.status === "rejected"))
          throw new Error("Integration credential revocation failed");
      },
    };
  }

  private async exchangeCode(app: GitHubAppCredentials, code: string): Promise<string> {
    const response = await this.request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code }),
    });
    if (typeof response.access_token !== "string" || !response.access_token)
      throw new Error("GitHub authorization code was rejected");
    return response.access_token;
  }

  private async revokeOAuthToken(app: GitHubAppCredentials, token: string): Promise<void> {
    const basic = Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64");
    await this.request(`${API}/applications/${encodeURIComponent(app.clientId)}/token`, {
      method: "DELETE",
      headers: {
        ...GITHUB_HEADERS,
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ access_token: token }),
    });
  }

  private async mintGitHubToken(
    invocation: ToolInvocation,
    requirement: ToolIntegrationRequirement,
    config: Readonly<Record<string, string>>,
  ): Promise<{ token: string; revoke: () => Promise<void> }> {
    const app = this.options.github;
    const repository = invocation.scope?.toLowerCase();
    let names: unknown;
    let ids: unknown;
    try {
      names = JSON.parse(config.repositories_json ?? "null") as unknown;
      ids = JSON.parse(config.repository_ids_json ?? "null") as unknown;
    } catch {
      throw new Error("GitHub integration configuration is invalid");
    }
    if (
      !app ||
      !config.installation_id ||
      !repository ||
      !Array.isArray(names) ||
      !Array.isArray(ids) ||
      names.length !== ids.length
    ) {
      throw new Error("GitHub integration configuration is invalid");
    }
    const index = names.findIndex((name) => name === repository);
    if (index < 0) throw new Error("Repository is not selected for this room");
    const repoId = Number(ids[index]);
    if (!Number.isSafeInteger(repoId) || repoId <= 0)
      throw new Error("GitHub integration configuration is invalid");

    const response = await this.request(
      `${API}/app/installations/${encodeURIComponent(config.installation_id)}/access_tokens`,
      {
        method: "POST",
        headers: this.appHeaders(app),
        body: JSON.stringify({
          repository_ids: [repoId],
          permissions: requirement.permissions ?? {},
        }),
      },
    );
    if (typeof response.token !== "string")
      throw new Error("GitHub did not return an installation token");
    const token = response.token;
    return {
      token,
      revoke: async () => {
        await this.request(`${API}/installation/token`, {
          method: "DELETE",
          headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}` },
        });
      },
    };
  }

  private appHeaders(app: GitHubAppCredentials): Record<string, string> {
    return {
      ...GITHUB_HEADERS,
      authorization: `Bearer ${createAppJwt(app)}`,
      "content-type": "application/json",
    };
  }

  private async githubPages<T>(
    path: string,
    token: string,
    collection: "installations" | "repositories",
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.request(`${API}${path}${separator}page=${page}`, {
        headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}` },
      });
      const items = response[collection];
      if (!Array.isArray(items)) throw new Error("GitHub returned an invalid list");
      rows.push(...(items as T[]));
      if (items.length < 100) return rows;
    }
    throw new Error("GitHub list exceeded the pagination limit");
  }

  private async request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("GitHub request failed");
    if (response.status === 204) return {};
    const value: unknown = await response.json().catch(() => undefined);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("GitHub response was invalid");
    return value as Record<string, unknown>;
  }
}

async function assumeAwsRole(input: AssumeRoleInput): Promise<AssumeRoleOutput> {
  const client = new STSClient({});
  try {
    const response = await client.send(
      new AssumeRoleCommand({
        RoleArn: input.role_arn,
        ExternalId: input.external_id,
        RoleSessionName: `crossover-${(input.invocation_id ?? "connect").replace(/[^A-Za-z0-9+=,.@_-]/g, "").slice(-55)}`,
        DurationSeconds: 900,
      }),
    );
    const credentials = response.Credentials;
    return {
      ...(credentials?.AccessKeyId ? { accessKeyId: credentials.AccessKeyId } : {}),
      ...(credentials?.SecretAccessKey ? { secretAccessKey: credentials.SecretAccessKey } : {}),
      ...(credentials?.SessionToken ? { sessionToken: credentials.SessionToken } : {}),
    };
  } finally {
    client.destroy();
  }
}

function createAppJwt(app: GitHubAppCredentials): string {
  const issuedAt = Math.floor(Date.now() / 1000) - 60;
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: app.appId }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), app.privateKey).toString("base64url")}`;
}
