import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The nightly Compose rehearsal (T1570). The default config only includes
// {packages,apps}/*/src/**/*.test.ts, so `pnpm test` never starts this. The harness prints one line
// per step; vitest's own reporter stays quiet.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["scripts/compose-rehearsal/*.rehearsal.ts"],
    reporters: ["dot"],
    testTimeout: 1_800_000,
    hookTimeout: 300_000,
  },
});
