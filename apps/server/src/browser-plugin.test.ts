import { describe, expect, it } from "vitest";
import { ToolRegistry } from "@crossover/kernel";
import {
  browserNavigateParams,
  browserReadPageParams,
  registerBrowserTools,
} from "./browser-plugin.js";

const image = `registry.example/crossover-browser-plugin@sha256:${"a".repeat(64)}`;

describe("browser plugin tools", () => {
  it("registers stateless browser calls under the shared tier-2 capability and room allowlist", () => {
    const registry = new ToolRegistry({
      tierOf: (capability) => (capability === "browser.navigate" ? 2 : 0),
    });
    registerBrowserTools(registry, image);

    for (const name of ["browser.navigate", "browser.read_page"]) {
      const tool = registry.get(name)!;
      expect(tool.capability).toBe("browser.navigate");
      expect(tool.tier).toBe(2);
      expect(tool.execution).toMatchObject({
        image,
        egressHosts: [],
        roomEgressAllowlist: true,
        pidsLimit: 256,
        maxOutputBytes: 256 * 1024,
      });
      expect(tool.execution?.command).toEqual(["node", "/app/plugins/browser/worker.mjs"]);
    }

    expect(
      registry
        .list()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["browser.navigate", "browser.read_page"]);
  });

  it("accepts only HTTPS URLs on port 443 without credentials", () => {
    for (const url of ["https://example.com", "https://example.com:443/path"]) {
      expect(browserNavigateParams.parse({ url }).url).toBe(url);
      expect(browserReadPageParams.parse({ url, selector: "main" }).selector).toBe("main");
    }
    for (const url of [
      "http://example.com",
      "file:///etc/passwd",
      "data:text/plain,hi",
      "javascript:alert(1)",
      "https://example.com:444",
      "https://user@example.com",
    ]) {
      expect(browserNavigateParams.safeParse({ url }).success, url).toBe(false);
    }
    expect(
      browserReadPageParams.safeParse({ url: "https://example.com", unknown: true }).success,
    ).toBe(false);
  });
});
