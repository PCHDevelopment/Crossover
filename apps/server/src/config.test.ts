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
});
