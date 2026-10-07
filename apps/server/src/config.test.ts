import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const env = {
  DATABASE_URL: "postgres://x",
  REDIS_URL: "redis://x",
  WORKSPACE_ROOT: "./data",
};

describe("sandbox disk enforcement configuration", () => {
  it("defaults to soft in development and accepts soft without a quota driver", () => {
    expect(loadConfig(env)).toMatchObject({
      sandboxDiskEnforcement: "soft",
      sandboxVolumeOptions: {},
    });
    expect(
      loadConfig({ ...env, NODE_ENV: "production", SANDBOX_DISK_ENFORCEMENT: "soft" }),
    ).toMatchObject({ sandboxDiskEnforcement: "soft", sandboxVolumeOptions: {} });
  });

  it("defaults production to hard and requires operator volume quota configuration", () => {
    expect(() => loadConfig({ ...env, NODE_ENV: "production" })).toThrow(
      /SANDBOX_DISK_ENFORCEMENT=hard requires SANDBOX_VOLUME_DRIVER and SANDBOX_VOLUME_OPTS/,
    );
    expect(
      loadConfig({
        ...env,
        NODE_ENV: "production",
        SANDBOX_VOLUME_DRIVER: "local",
        SANDBOX_VOLUME_OPTS: '{"type":"none","device":"/srv/sandbox","o":"bind,pquota"}',
      }),
    ).toMatchObject({
      sandboxDiskEnforcement: "hard",
      sandboxVolumeDriver: "local",
      sandboxVolumeOptions: { type: "none", device: "/srv/sandbox", o: "bind,pquota" },
    });
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
      gitFetcherImage: "crossover-git-fetcher:latest",
    });
    expect(
      loadConfig({
        ...env,
        GIT_INTERNAL_HOST: "172.30.0.2",
        GIT_INTERNAL_PORT: "8082",
        GIT_INTERNAL_CONTAINER: "crossover-server",
        GIT_INTERNAL_TOKEN_SECRET: "0123456789abcdef0123456789abcdef",
        GIT_FETCHER_IMAGE: "crossover-git-fetcher:test",
      }),
    ).toMatchObject({
      gitInternalHost: "172.30.0.2",
      gitInternalPort: 8082,
      gitInternalContainer: "crossover-server",
      gitInternalTokenSecret: "0123456789abcdef0123456789abcdef",
      gitFetcherImage: "crossover-git-fetcher:test",
    });
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
});
