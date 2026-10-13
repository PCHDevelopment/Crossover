// Compile policy/authz.rego to policy/policy.wasm (`gen:wasm`), or with `--check` fail if the
// committed module is stale. Needs `opa` (OPA_BIN, or on PATH) at the version pinned here and in
// .github/workflows/ci.yml.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const OPA_VERSION = "1.21.2";
const root = fileURLToPath(new URL("..", import.meta.url));
const opa = process.env["OPA_BIN"] ?? "opa";
const target = join(root, "policy", "policy.wasm");

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
    const bundle = join(work, "bundle.tar.gz");
    execFileSync(
      opa,
      [
        "build",
        ...["-t", "wasm", "-e", "crossover/authz/decision", "-o", bundle],
        // Relative to the working directory: the module embeds the source path it was built from,
        // so an absolute one would make it differ from machine to machine.
        "authz.rego",
      ],
      { cwd: join(root, "policy"), stdio: "inherit" },
    );
    const built = fileFromTar(gunzipSync(readFileSync(bundle)), "policy.wasm");
    if (!process.argv.includes("--check")) {
      writeFileSync(target, built);
      process.stdout.write(`wrote policy/policy.wasm (${built.length} bytes)\n`);
      return;
    }
    let current = Buffer.alloc(0);
    try {
      current = readFileSync(target);
    } catch {
      // Missing counts as stale.
    }
    if (!current.equals(built)) {
      console.error(
        "policy/policy.wasm is out of date: run `pnpm --filter @crossover/policy gen:wasm`",
      );
      process.exit(1);
    }
    process.stdout.write("policy/policy.wasm is up to date\n");
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
