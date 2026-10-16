import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SANDBOX_SNAPSHOT_HELPER } from "./sandbox-snapshot-helper.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface HelperResult {
  code: number;
  entries?: { path: string; mode: string; sha: string | null; size: number }[];
  file?: { path: string; mode: string; size: number; content: string };
  error?: string;
  pruned_directories?: string[];
}

async function runHelper(
  root: string,
  input: Record<string, unknown>,
  options?: { pauseAt: string; onPause: () => Promise<void> },
): Promise<HelperResult> {
  return new Promise((resolve, reject) => {
    const script = options
      ? SANDBOX_SNAPSHOT_HELPER.replace(
          "const beforeDir = await directory.stat({ bigint: true });",
          `const beforeDir = await directory.stat({ bigint: true }); process.stderr.write("walk:" + prefix.toString("utf8") + "\\n"); if (prefix.toString("utf8") === ${JSON.stringify(options.pauseAt)}) await new Promise((resolve) => setTimeout(resolve, 100));`,
        )
      : SANDBOX_SNAPSHOT_HELPER;
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let sideEffect = Promise.resolve();
    let pauseHandled = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (!pauseHandled && options && stderr.includes(`walk:${options.pauseAt}\n`)) {
        pauseHandled = true;
        sideEffect = options.onPause();
      }
    });
    child.once("error", reject);
    child.once("close", async (code) => {
      try {
        await sideEffect;
        resolve({ code: code ?? 1, ...JSON.parse(stdout) });
      } catch {
        reject(new Error(`Snapshot helper returned invalid JSON: ${stderr}`));
      }
    });
    child.stdin.end(JSON.stringify({ root, hash: "sha1", ...input }));
  });
}
function gitBlobHash(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
const path64 = (path: string) => Buffer.from(path).toString("base64");
const decodePath = (path: string) => Buffer.from(path, "base64").toString();

describe("sandbox snapshot helper", () => {
  // Measured (T1529): idle 2794 ms, 3x load 3648 ms; budget 7x.
  it("reads one working-copy file without following links or accepting a missing path", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sandbox-snapshot-"));
    roots.push(root);
    await writeFile(join(root, "file.txt"), "working copy\n");
    await symlink("/etc/passwd", join(root, "link"));

    const read = await runHelper(root, {
      action: "file_read",
      path: path64("file.txt"),
      max_bytes: 1024,
    });
    expect(read).toMatchObject({
      code: 0,
      file: {
        path: path64("file.txt"),
        mode: "100644",
        size: Buffer.byteLength("working copy\n"),
        content: Buffer.from("working copy\n").toString("base64"),
      },
    });
    expect(
      await runHelper(root, { action: "file_read", path: path64("link"), max_bytes: 1024 }),
    ).toMatchObject({ code: 1, error: "unsupported_file_type" });
    expect(
      await runHelper(root, { action: "file_read", path: path64("missing"), max_bytes: 1024 }),
    ).toMatchObject({ code: 1, error: "path_not_found" });
    expect(
      await runHelper(root, {
        action: "file_read",
        path: path64("../etc/passwd"),
        max_bytes: 1024,
      }),
    ).toMatchObject({ code: 1, error: "invalid_path" });
    expect(
      await runHelper(root, { action: "file_read", path: path64("file.txt"), max_bytes: 2 }),
    ).toMatchObject({ code: 1, error: "too_large", size: 13, limit: 2 });
  }, 30_000);

  it("reads raw bytes, ignores sandbox Git configuration, and never follows symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sandbox-snapshot-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".git"), { recursive: true });
    const marker = join(root, "fsmonitor-ran");
    await writeFile(
      join(workspace, ".git", "config"),
      `[core]\nfsmonitor=!touch ${marker}\n[filter "evil"]\nclean=touch ${marker}\n`,
    );
    await writeFile(join(workspace, ".gitattributes"), "*.bin filter=evil\n");
    await writeFile(join(workspace, ".gitignore"), "*.txt\n");
    const binary = Buffer.from([0, 1, 2, 0xff, 0x0a]);
    await writeFile(join(workspace, "sample.bin"), binary);
    await symlink("/etc/passwd", join(workspace, "passwd-link"));

    const inventory = await runHelper(workspace, {
      action: "inventory",
      tracked_paths: [path64("sample.bin"), path64("passwd-link")],
    });
    const entries = inventory.entries!;
    expect(entries.map(({ path }) => path).sort()).toEqual(
      [".gitattributes", ".gitignore", "passwd-link", "sample.bin"].map(path64).sort(),
    );
    expect(entries.find(({ path }) => path === path64("sample.bin"))).toMatchObject({
      mode: "100644",
      sha: gitBlobHash(binary),
      size: binary.length,
    });
    expect(entries.find(({ path }) => path === path64("passwd-link"))).toMatchObject({
      mode: "120000",
      sha: gitBlobHash(Buffer.from("/etc/passwd")),
    });
    expect(await readFile(marker).catch(() => null)).toBeNull();
  });

  // Measured (T1529): idle 2319 ms, 3x load 3988 ms; budget 7x.
  it("prunes ignored node_modules before counting or stat-checking its entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sandbox-snapshot-"));
    roots.push(root);
    const ignored = join(root, "node_modules");
    await mkdir(ignored);
    await Promise.all(
      Array.from({ length: 4 }, (_, index) => writeFile(join(ignored, `file-${index}`), "x")),
    );
    await writeFile(join(root, "keep.txt"), "visible");
    const inventory = await runHelper(
      root,
      {
        action: "inventory",
        max_entries: 1,
        ignore_rules: [{ path: ".gitignore", patterns: ["node_modules/", "*.txt"] }],
      },
      {
        pauseAt: "",
        onPause: () => writeFile(join(ignored, "concurrent.log"), "generated"),
      },
    );
    expect(inventory.entries?.map(({ path }) => decodePath(path))).toEqual(["keep.txt"]);
    expect(inventory.pruned_directories?.map(decodePath)).toEqual(["node_modules"]);
    const unpruned = await runHelper(root, {
      action: "inventory",
      ignore_rules: [{ path: ".gitignore", patterns: ["node_modules/"] }],
      unprune_directories: [path64("node_modules")],
    });
    expect(unpruned.entries?.map(({ path }) => decodePath(path))).toContain("node_modules/file-0");
    expect(unpruned.pruned_directories).toEqual([]);
    const tooMany = await runHelper(root, { action: "inventory", max_entries: 1 });
    expect(tooMany.error).toBe("too_many_entries");
    const tooLargeInput = {
      action: "inventory",
      tracked_paths: [path64("keep.txt")],
      max_bytes: 0,
    };
    expect((await runHelper(root, tooLargeInput)).error).toBe("scan_too_large");
    const live = join(root, "live");
    await mkdir(live);
    await writeFile(join(live, "before.txt"), "before");
    const result = await runHelper(
      root,
      { action: "inventory" },
      {
        pauseAt: "live",
        onPause: () => writeFile(join(live, "concurrent.log"), "generated"),
      },
    );
    expect(result.error).toBe("changed_during_read");
  }, 30_000);

  it("rejects bytes changed after inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sandbox-snapshot-"));
    roots.push(root);
    await writeFile(join(root, "tracked.txt"), "old");
    const inventory = await runHelper(root, {
      action: "inventory",
      tracked_paths: [path64("tracked.txt")],
    });
    const tracked = inventory.entries![0]!;
    await writeFile(join(root, "tracked.txt"), "new"); // Same byte length; stat alone would miss it.
    const changed = await runHelper(root, { action: "read", paths: [tracked] });
    expect(changed).toMatchObject({ code: 1, error: "changed_during_read" });
  });

  // Measured (T1529): idle 920 ms, 3x load 2436 ms; budget 7x.
  it("installs a rebased delta without following an existing sandbox symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sandbox-snapshot-"));
    roots.push(root);
    const outside = join(root, "outside.txt");
    await Promise.all([writeFile(outside, "keep me"), mkdir(join(root, "nested"))]);
    await symlink(outside, join(root, "nested", "escape"));

    await runHelper(root, {
      action: "install",
      delete_paths: [path64("nested/escape")],
      files: [
        {
          path: path64("bin/tool"),
          mode: "100755",
          content: Buffer.from([0, 1, 255]).toString("base64"),
        },
      ],
    });
    expect(await readFile(outside, "utf8")).toBe("keep me");
    expect((await readFile(join(root, "bin/tool"))).toString("hex")).toBe("0001ff");
    expect(await readdir(join(root, "nested"))).toEqual([]);

    await chmod(join(root, "bin/tool"), 0o755);
    await runHelper(root, {
      action: "install",
      files: [
        {
          path: path64("bin/tool"),
          mode: "100644",
          content: Buffer.from("edited executable").toString("base64"),
          preserve_mode: true,
        },
      ],
    });
    expect((await stat(join(root, "bin/tool"))).mode & 0o777).toBe(0o755);
  }, 20_000);
});
