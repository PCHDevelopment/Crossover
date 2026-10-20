import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const env = {
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  WORKSPACE_ROOT: "./data",
  ALLOW_UNSANDBOXED_DEV: "1",
};

describe("OAuth provider configuration", () => {
  it("does not select a test stub provider from environment variables", () => {
    expect(
      loadConfig({ ...env, OAUTH_STUB_PROVIDER_URL: "https://stub.example.test/authorize" }).oauth,
    ).toBeUndefined();
  });
});

describe("sandbox disk enforcement configuration", () => {
  it("defaults to soft in development and accepts soft without a quota driver", () => {
    expect(loadConfig(env)).toMatchObject({
      sandboxDiskEnforcement: "soft",
      sandboxVolumeOptions: {},
    });
    expect(
      loadConfig({
        ...env,
        NODE_ENV: "production",
        SANDBOX_RUNTIME: "runsc",
        ALLOW_UNSANDBOXED_DEV: undefined,
        SANDBOX_DISK_ENFORCEMENT: "soft",
        INTEGRATION_KMS_KEY_ID: "alias/crossover-test",
      }),
    ).toMatchObject({ sandboxDiskEnforcement: "soft", sandboxVolumeOptions: {} });
  });

  it("defaults production to hard and requires operator volume quota configuration", () => {
    expect(() =>
      loadConfig({
        ...env,
        NODE_ENV: "production",
        SANDBOX_RUNTIME: "runsc",
        ALLOW_UNSANDBOXED_DEV: undefined,
      }),
    ).toThrow(
      /SANDBOX_DISK_ENFORCEMENT=hard requires SANDBOX_VOLUME_DRIVER and SANDBOX_VOLUME_OPTS/,
    );
    expect(
      loadConfig({
        ...env,
        NODE_ENV: "production",
        SANDBOX_RUNTIME: "runsc",
        ALLOW_UNSANDBOXED_DEV: undefined,
        INTEGRATION_KMS_KEY_ID: "alias/crossover-test",
        SANDBOX_VOLUME_DRIVER: "local",
        SANDBOX_VOLUME_OPTS: '{"type":"none","device":"/srv/sandbox","o":"bind,pquota"}',
      }),
    ).toMatchObject({
      sandboxDiskEnforcement: "hard",
      sandboxVolumeDriver: "local",
      sandboxVolumeOptions: { type: "none", device: "/srv/sandbox", o: "bind,pquota" },
    });
  });

  it("uses a config key only in development and requires KMS for production", () => {
    const configured = loadConfig({ ...env, INTEGRATION_SECRET_KEY: "ab".repeat(32) });
    expect(Buffer.from(configured.integrationSecretKey ?? []).toString("hex")).toBe(
      "ab".repeat(32),
    );
    expect(() => loadConfig({ ...env, INTEGRATION_SECRET_KEY: "too-short" })).toThrow(
      /INTEGRATION_SECRET_KEY/,
    );
    expect(() =>
      loadConfig({
        ...env,
        NODE_ENV: "production",
        SANDBOX_RUNTIME: "runsc",
        ALLOW_UNSANDBOXED_DEV: undefined,
        SANDBOX_DISK_ENFORCEMENT: "soft",
      }),
    ).toThrow(/INTEGRATION_KMS_KEY_ID is required in production/);
    expect(() =>
      loadConfig({
        ...env,
        NODE_ENV: "production",
        SANDBOX_RUNTIME: "runsc",
        ALLOW_UNSANDBOXED_DEV: undefined,
        SANDBOX_DISK_ENFORCEMENT: "soft",
        INTEGRATION_KMS_KEY_ID: "alias/crossover-test",
        INTEGRATION_SECRET_KEY: "ab".repeat(32),
      }),
    ).toThrow(/INTEGRATION_SECRET_KEY is development-only/);
  });

  it("rejects invalid enforcement values and malformed volume options", () => {
    expect(() => loadConfig({ ...env, SANDBOX_DISK_ENFORCEMENT: "best-effort" })).toThrow(
      /SANDBOX_DISK_ENFORCEMENT/,
    );
    expect(() =>
      loadConfig({ ...env, SANDBOX_VOLUME_OPTS: "type=none,device=/srv/sandbox" }),
    ).toThrow(/SANDBOX_VOLUME_OPTS/);
  });

  it("passes through an optional sandbox runtime such as gVisor", () => {
    expect(loadConfig({ ...env, SANDBOX_RUNTIME: "runsc" })).toMatchObject({
      sandboxRuntime: "runsc",
    });
    expect(() => loadConfig({ ...env, SANDBOX_RUNTIME: "  " })).toThrow(/SANDBOX_RUNTIME/);
  });

  it("requires gVisor unless the development-only opt-out is enabled", () => {
    expect(
      loadConfig({ ...env, SANDBOX_RUNTIME: "runsc", ALLOW_UNSANDBOXED_DEV: undefined }),
    ).toMatchObject({ sandboxRuntime: "runsc", allowUnsandboxedDev: false });
    expect(() =>
      loadConfig({ ...env, SANDBOX_RUNTIME: undefined, ALLOW_UNSANDBOXED_DEV: undefined }),
    ).toThrow(
      "Invalid server configuration:\n  SANDBOX_RUNTIME=runsc is required: sandboxes share this host (single-host mode, ARCHITECTURE §4.1). Set ALLOW_UNSANDBOXED_DEV=1 only for local development.",
    );
    expect(
      loadConfig({ ...env, SANDBOX_RUNTIME: undefined, ALLOW_UNSANDBOXED_DEV: "1" }),
    ).toMatchObject({ allowUnsandboxedDev: true });
    expect(() =>
      loadConfig({ ...env, NODE_ENV: "production", ALLOW_UNSANDBOXED_DEV: "1" }),
    ).toThrow(
      "Invalid server configuration:\n  ALLOW_UNSANDBOXED_DEV is refused when NODE_ENV=production",
    );
  });

  it("configures only a named egress proxy and validates its port", () => {
    expect(
      loadConfig({
        ...env,
        SANDBOX_EGRESS_PROXY_CONTAINER: "egress-proxy",
        SANDBOX_EGRESS_PROXY_PORT: "3128",
        SANDBOX_EGRESS_PROXY_SECRET: "0123456789abcdef0123456789abcdef",
      }),
    ).toMatchObject({
      sandboxEgressProxyContainer: "egress-proxy",
      sandboxEgressProxyPort: 3128,
      sandboxEgressProxySecret: "0123456789abcdef0123456789abcdef",
    });
    expect(() => loadConfig({ ...env, SANDBOX_EGRESS_PROXY_PORT: "3128" })).toThrow(
      /requires SANDBOX_EGRESS_PROXY_CONTAINER/,
    );
    expect(() => loadConfig({ ...env, SANDBOX_EGRESS_PROXY_CONTAINER: "egress-proxy" })).toThrow(
      /requires SANDBOX_EGRESS_PROXY_SECRET/,
    );
    expect(() =>
      loadConfig({
        ...env,
        SANDBOX_EGRESS_PROXY_CONTAINER: "egress-proxy",
        SANDBOX_EGRESS_PROXY_SECRET: "too-short",
      }),
    ).toThrow(/SANDBOX_EGRESS_PROXY_SECRET/);
    expect(() => loadConfig({ ...env, SANDBOX_EGRESS_PROXY_CONTAINER: "Egress Proxy" })).toThrow(
      /SANDBOX_EGRESS_PROXY_CONTAINER/,
    );
  });
});

describe("internal Git listener configuration", () => {
  it("uses a private default address and port and accepts the paired fetcher settings", () => {
    expect(loadConfig(env)).toMatchObject({
      gitInternalPort: 8081,
      gitInternalNetwork: "crossover-git",
      gitFetcherImage: "crossover-git-fetcher:latest",
    });
    expect(
      loadConfig({
        ...env,
        GIT_INTERNAL_HOST: "172.30.0.2",
        GIT_INTERNAL_NETWORK: "private-git",
        GIT_INTERNAL_PORT: "8082",
        GIT_INTERNAL_CONTAINER: "crossover-server",
        GIT_INTERNAL_TOKEN_SECRET: "0123456789abcdef0123456789abcdef",
        GIT_FETCHER_IMAGE: "crossover-git-fetcher:test",
      }),
    ).toMatchObject({
      gitInternalHost: "172.30.0.2",
      gitInternalNetwork: "private-git",
      gitInternalPort: 8082,
      gitInternalContainer: "crossover-server",
      gitInternalTokenSecret: "0123456789abcdef0123456789abcdef",
      gitFetcherImage: "crossover-git-fetcher:test",
    });
  });

  it("validates the configured private Git network name", () => {
    expect(() => loadConfig({ ...env, GIT_INTERNAL_NETWORK: "Private Git" })).toThrow(
      /GIT_INTERNAL_NETWORK/,
    );
  });

  it("requires a server container and signing key as a pair", () => {
    expect(() => loadConfig({ ...env, GIT_INTERNAL_CONTAINER: "crossover-server" })).toThrow(
      /GIT_INTERNAL_CONTAINER requires GIT_INTERNAL_TOKEN_SECRET/,
    );
    expect(() =>
      loadConfig({
        ...env,
        GIT_INTERNAL_TOKEN_SECRET: "0123456789abcdef0123456789abcdef",
      }),
    ).toThrow(/GIT_INTERNAL_TOKEN_SECRET requires GIT_INTERNAL_CONTAINER/);
    expect(() =>
      loadConfig({
        ...env,
        GIT_INTERNAL_CONTAINER: "crossover-server",
        GIT_INTERNAL_TOKEN_SECRET: "0123456789abcdef0123456789abcdef",
      }),
    ).toThrow(/GIT_INTERNAL_HOST is required/);
    expect(() =>
      loadConfig({
        ...env,
        GIT_INTERNAL_HOST: "0.0.0.0",
        GIT_INTERNAL_CONTAINER: "crossover-server",
        GIT_INTERNAL_TOKEN_SECRET: "0123456789abcdef0123456789abcdef",
      }),
    ).toThrow(/specific private-network address/);
  });

  it("keeps ripgrep by default and validates enabled Zoekt paths", () => {
    expect(loadConfig(env).searchBackend).toBe("ripgrep");
    expect(() =>
      loadConfig({ ...env, SEARCH_BACKEND: "zoekt", ZOEKT_INDEX_DIR: "/tmp/zoekt" }),
    ).toThrow(/requires ZOEKT_URL and ZOEKT_INDEX_DIR/);
    expect(() =>
      loadConfig({
        ...env,
        SEARCH_BACKEND: "zoekt",
        ZOEKT_URL: "http://zoekt:6070",
        ZOEKT_INDEX_DIR: `${env.WORKSPACE_ROOT}/shards`,
      }),
    ).toThrow(/outside WORKSPACE_ROOT/);
    expect(
      loadConfig({
        ...env,
        SEARCH_BACKEND: "zoekt",
        ZOEKT_URL: "http://zoekt:6070",
        ZOEKT_INDEX_DIR: "/tmp/crossover-zoekt",
        ZOEKT_INDEX_CONCURRENCY: "4",
      }),
    ).toMatchObject({ searchBackend: "zoekt", zoektIndexConcurrency: 4 });
  });

  it("rejects an index path through a symlinked workspace parent and caps the timeout", () => {
    const root = mkdtempSync(join(tmpdir(), "zoekt-config-"));
    try {
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      symlinkSync(workspace, join(root, "alias"));
      const zoekt = {
        ...env,
        WORKSPACE_ROOT: workspace,
        SEARCH_BACKEND: "zoekt",
        ZOEKT_URL: "http://zoekt:6070",
      };
      expect(() =>
        loadConfig({ ...zoekt, ZOEKT_INDEX_DIR: join(root, "alias", "missing", "shards") }),
      ).toThrow(/outside WORKSPACE_ROOT/);
      expect(
        loadConfig({ ...zoekt, ZOEKT_INDEX_DIR: join(root, "alias-other", "shards") })
          .zoektIndexDir,
      ).toBe(join(root, "alias-other", "shards"));
      expect(() =>
        loadConfig({ ...zoekt, ZOEKT_INDEX_DIR: root, ZOEKT_INDEX_TIMEOUT_MS: "2147483648" }),
      ).toThrow(/ZOEKT_INDEX_TIMEOUT_MS/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("GitHub integration configuration", () => {
  it("treats blank Compose pass-through values as unset when the App is disabled", () => {
    expect(
      loadConfig({
        ...env,
        GITHUB_APP_ID: "",
        GITHUB_APP_SLUG: "",
        GITHUB_CLIENT_ID: "",
        GITHUB_CLIENT_SECRET: "",
        GITHUB_APP_PRIVATE_KEY: "",
        INTEGRATION_SECRET_KEY: "",
        INTEGRATION_KMS_KEY_ID: "",
      }).githubApp,
    ).toBeUndefined();
  });

  it("requires operator credentials as a complete set and normalizes PEM newlines", () => {
    expect(() => loadConfig({ ...env, GITHUB_APP_ID: "123" })).toThrow(
      /must be configured together/,
    );
    const configured = loadConfig({
      ...env,
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "crossover-github",
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\\n${"x".repeat(100)}\\n-----END PRIVATE KEY-----`,
      INTEGRATION_SECRET_KEY: "ab".repeat(32),
    });
    expect(configured.githubApp).toMatchObject({
      appId: "123",
      slug: "crossover-github",
      clientId: "client-id",
      clientSecret: "client-secret",
      privateKey: expect.stringContaining("\n"),
    });
    expect(() =>
      loadConfig({
        ...env,
        GITHUB_APP_ID: "123",
        GITHUB_CLIENT_ID: "client-id",
        GITHUB_CLIENT_SECRET: "client-secret",
        GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\\n${"x".repeat(100)}\\n-----END PRIVATE KEY-----`,
      }),
    ).toThrow(/GITHUB_APP_ID, GITHUB_APP_SLUG/);
    expect(() => loadConfig({ ...env, GITHUB_APP_SLUG: "Invalid Slug" })).toThrow(
      /GITHUB_APP_SLUG/,
    );
  });

  it("requires an integration secret store when the GitHub App is configured", () => {
    const app = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_SLUG: "crossover-github",
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_APP_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\\n${"x".repeat(100)}\\n-----END PRIVATE KEY-----`,
    };
    expect(() => loadConfig({ ...env, ...app })).toThrow(
      /GitHub App integration requires an integration secret store.*INTEGRATION_SECRET_KEY.*INTEGRATION_KMS_KEY_ID/,
    );
    expect(
      loadConfig({ ...env, ...app, INTEGRATION_SECRET_KEY: "ab".repeat(32) }).githubApp,
    ).toBeDefined();
    expect(
      loadConfig({ ...env, ...app, INTEGRATION_KMS_KEY_ID: "alias/crossover-test" }).githubApp,
    ).toBeDefined();
  });

  it("accepts only a digest-pinned GitHub plugin worker image", () => {
    expect(() =>
      loadConfig({ ...env, GITHUB_PLUGIN_IMAGE: "crossover-github-plugin:latest" }),
    ).toThrow(/GITHUB_PLUGIN_IMAGE/);
    const image = `ghcr.io/peterheo/crossover-github-plugin@sha256:${"a".repeat(64)}`;
    expect(loadConfig({ ...env, GITHUB_PLUGIN_IMAGE: image }).githubPluginImage).toBe(image);
  });
});

describe("browser plugin image configuration", () => {
  it("accepts only digest-pinned browser worker images", () => {
    const image = `ghcr.io/peterheo/crossover-browser-plugin@sha256:${"b".repeat(64)}`;
    expect(() =>
      loadConfig({ ...env, BROWSER_PLUGIN_IMAGE: "crossover-browser-plugin:latest" }),
    ).toThrow(/BROWSER_PLUGIN_IMAGE/);
    expect(loadConfig({ ...env, BROWSER_PLUGIN_IMAGE: image }).browserPluginImage).toBe(image);
  });
});

describe("memory search provider configuration", () => {
  it("defaults off and accepts the local provider", () => {
    expect(loadConfig(env).memorySearchProvider).toBe("off");
    expect(loadConfig({ ...env, MEMORY_SEARCH_PROVIDER: "local-hash" }).memorySearchProvider).toBe(
      "local-hash",
    );
  });
  it("rejects unknown providers", () => {
    expect(() => loadConfig({ ...env, MEMORY_SEARCH_PROVIDER: "remote" })).toThrow(
      /MEMORY_SEARCH_PROVIDER/,
    );
  });
});
