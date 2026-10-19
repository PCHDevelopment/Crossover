import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function pin(path: URL): string {
  const dockerfile = readFileSync(path, "utf8");
  const match = dockerfile.match(/^ARG ZOEKT_COMMIT=([0-9a-f]{40})$/m);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe("Zoekt image pins", () => {
  it("server and sidecar Dockerfiles pin the same Zoekt commit", () => {
    expect(pin(new URL("../../zoekt/Dockerfile", import.meta.url))).toBe(
      pin(new URL("../Dockerfile", import.meta.url)),
    );
  });
});
