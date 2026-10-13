// Generate policy/bundles.gen.rego (from bundles.ts) and policy/tiers.gen.rego (from tiers.ts) and
// compile them with the hand-written policy files to policy/policy.wasm (`gen:wasm`), or with
// `--check` fail if any committed file is stale. Needs `opa` (OPA_BIN, or on PATH) at the version
// pinned here and in .github/workflows/ci.yml.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { renderBundlesRego } from "./bundles-rego.js";
import { renderTiersRego } from "./tiers-rego.js";

const OPA_VERSION = "1.21.2";
const root = fileURLToPath(new URL("..", import.meta.url));
const opa = process.env["OPA_BIN"] ?? "opa";
const policyDir = join(root, "policy");
const WRITTEN = ["authz.rego", "scope.rego", "tiers.rego"];
const GENERATED: [string, () => string][] = [
  ["bundles.gen.rego", renderBundlesRego],
  ["tiers.gen.rego", renderTiersRego],
];
const SOURCES = [...WRITTEN, ...GENERATED.map(([name]) => name)];
// The first entrypoint is the module's default one (`PolicyEngine.decide`); `tier` is asked for by name.
const ENTRYPOINTS = ["crossover/authz/decision", "crossover/tiers/tier"];

main();

function main(): void {
  let version: string | undefined;
  try {
    version = /^Version:\s*(\S+)/m.exec(execFileSync(opa, ["version"], { encoding: "utf8" }))?.[1];
  } catch {
    // Not installed: reported below like a wrong version.
  }
  if (version !== OPA_VERSION) {
    console.error(`gen:wasm needs opa ${OPA_VERSION}, found ${version ?? "none"} (${opa})`);
    process.exit(2);
  }

  const work = mkdtempSync(join(tmpdir(), "crossover-policy-"));
  try {
    // Built in a scratch directory so the generated file never has to be on disk first, and so
    // `--check` compares what the sources produce with what is committed.
    for (const name of WRITTEN) copyFileSync(join(policyDir, name), join(work, name));
    // CI requires every file in policy/ to be `opa fmt` clean, the generated ones included.
    for (const [name, render] of GENERATED) {
      writeFileSync(join(work, name), render());
      execFileSync(opa, ["fmt", "--write", name], { cwd: work, stdio: "inherit" });
    }
    const bundle = join(work, "bundle.tar.gz");
    execFileSync(
      opa,
      [
        "build",
        ...["-t", "wasm", ...ENTRYPOINTS.flatMap((entrypoint) => ["-e", entrypoint]), "-o", bundle],
        // Relative to the working directory: the module embeds the source paths it was built
        // from, so absolute ones would make it differ from machine to machine.
        ...SOURCES,
      ],
      { cwd: work, stdio: "inherit" },
    );
    const outputs: [string, Buffer][] = [
      ...GENERATED.map(([name]): [string, Buffer] => [name, readFileSync(join(work, name))]),
      ["policy.wasm", fileFromTar(gunzipSync(readFileSync(bundle)), "policy.wasm")],
    ];
    if (!process.argv.includes("--check")) {
      for (const [name, content] of outputs) {
        writeFileSync(join(policyDir, name), content);
        process.stdout.write(`wrote policy/${name} (${content.length} bytes)\n`);
      }
      return;
    }
    const stale = outputs.filter(([name, content]) => {
      try {
        return !readFileSync(join(policyDir, name)).equals(content);
      } catch {
        return true; // Missing counts as stale.
      }
    });
    if (stale.length > 0) {
      console.error(
        `${stale.map(([name]) => `policy/${name}`).join(", ")} out of date: run \`pnpm --filter @crossover/policy gen:wasm\``,
      );
      process.exit(1);
    }
    process.stdout.write("the generated policy files and policy/policy.wasm are up to date\n");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The content of one file of a (ustar) tar archive; `name` may be stored with a leading slash. */
function fileFromTar(tar: Buffer, name: string): Buffer {
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const entry = header.toString("utf8", 0, 100).replace(/\0[\s\S]*$/, "");
    const size = parseInt(
      header
        .toString("ascii", 124, 136)
        .replace(/\0[\s\S]*$/, "")
        .trim(),
      8,
    );
    offset += 512;
    if (entry.replace(/^\/+/, "") === name) return tar.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
  }
  throw new Error(`${name} is not in the opa bundle`);
}
