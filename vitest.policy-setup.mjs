// The packages that depend on @crossover/policy call `tierOf`, which is synchronous and reads
// the policy a server loads before it listens (`initPolicy()` in apps/server/src/main.ts). Their
// tests load it the same way, once per test file, before the first test. @crossover/policy's own
// tests import its sources and load it where they need it.
import { expect } from "vitest";

const DEPENDENTS =
  /[\\/](packages[\\/](gateway|kernel|mcp|workspace)|apps[\\/]server)[\\/]src[\\/]/;

if (DEPENDENTS.test(expect.getState().testPath ?? "")) {
  const { initPolicy } = await import("./packages/policy/dist/index.js");
  await initPolicy();
}
