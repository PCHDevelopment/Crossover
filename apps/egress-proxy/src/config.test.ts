import { describe, expect, it } from "vitest";
import { loadEgressProxyConfig } from "./config.js";

describe("egress proxy config", () => {
  it("requires a database and a 32-byte minimum HMAC secret", () => {
    const env = {
      DATABASE_URL: "postgres://crossover:crossover@localhost:5432/crossover",
      SANDBOX_EGRESS_PROXY_SECRET: "0123456789abcdef0123456789abcdef",
    };
    expect(loadEgressProxyConfig(env)).toMatchObject({ host: "0.0.0.0", port: 3128 });
    expect(() => loadEgressProxyConfig({ ...env, SANDBOX_EGRESS_PROXY_SECRET: "short" })).toThrow(
      /SANDBOX_EGRESS_PROXY_SECRET/,
    );
    expect(() => loadEgressProxyConfig({ ...env, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });
});
