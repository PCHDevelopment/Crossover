import { describe, expect, it } from "vitest";
import { isAllowedEgressHost, normalizeRoomEgressAllowlist } from "./allowlist.js";

describe("egress allowlist", () => {
  it("allows default registries and source-download hosts", () => {
    for (const host of [
      "registry.npmjs.org",
      "pypi.org",
      "files.pythonhosted.org",
      "index.crates.io",
      "proxy.golang.org",
      "repo.maven.apache.org",
      "codeload.github.com",
    ]) {
      expect(isAllowedEgressHost(host), host).toBe(true);
    }
    expect(isAllowedEgressHost("example.com")).toBe(false);
  });

  it("matches room exact-host and subdomain-only wildcard additions", () => {
    const allowlist = normalizeRoomEgressAllowlist(["API.Example.com.", "*.packages.example"]);
    expect(isAllowedEgressHost("api.example.com", allowlist)).toBe(true);
    expect(isAllowedEgressHost("registry.packages.example", allowlist)).toBe(true);
    expect(isAllowedEgressHost("packages.example", allowlist)).toBe(false);
    expect(isAllowedEgressHost("other.example.com", allowlist)).toBe(false);
  });

  it("rejects malformed patterns and IP literals", () => {
    for (const value of [
      "https://example.com",
      "example.com:443",
      "*.com",
      "127.0.0.1",
      "localhost",
    ]) {
      expect(() => normalizeRoomEgressAllowlist([value]), value).toThrow(/egress allowlist/);
    }
    expect(() => normalizeRoomEgressAllowlist("example.com")).toThrow(/array/);
  });
});
