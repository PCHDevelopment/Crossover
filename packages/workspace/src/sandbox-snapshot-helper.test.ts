import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
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
  entries?: { path: string; mode: string; sha: string | null; size: number; content?: string }[];
  error?: string;
}

async function runHelper(root: string, input: Record<string, unknown>): Promise<HelperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", SANDBOX_SNAPSHOT_HELPER], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      try {
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

function path64(path: string): string {
  return Buffer.from(path).toString("base64");
}

describe("sandbox snapshot helper", () => {
  it("reads raw bytes, ignores sandbox Git configuration, and never follows symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sandbox-snapshot-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await mkdir(outside);

    const marker = join(root, "fsmonitor-ran");
    await writeFile(
      join(workspace, ".git", "config"),
      `[core]\n\tfsmonitor = !touch ${marker}\n[filter "evil"]\n\tclean = touch ${marker}\n`,
    );
    await writeFile(join(workspace, ".gitattributes"), "*.bin filter=evil\n");
    await writeFile(join(workspace, ".gitignore"), "*.txt\n");
    const binary = Buffer.from([0, 1, 2, 0xff, 0x0a]);
    await writeFile(join(workspace, "sample.bin"), binary);
    await writeFile(join(outside, "secret.txt"), "outside secret");
    await symlink("../outside/secret.txt", join(workspace, "link"));
    await symlink("../outside", join(workspace, "escape"));
    await symlink("/etc/passwd", join(workspace, "passwd-link"));

    const inventory = await runHelper(workspace, {
      action: "inventory",
      tracked_paths: [path64("sample.bin"), path64("link")],
    });
    expect(inventory.code).toBe(0);
    const entries = inventory.entries!;
    expect(entries.map(({ path }) => Buffer.from(path, "base64").toString()).sort()).toEqual(
      [".gitattributes", ".gitignore", "escape", "link", "passwd-link", "sample.bin"].sort(),
    );
    expect(
      entries.find(({ path }) => Buffer.from(path, "base64").toString() === "sample.bin"),
    ).toMatchObject({ mode: "100644", sha: gitBlobHash(binary), size: binary.length });
    expect(
      entries.find(({ path }) => Buffer.from(path, "base64").toString() === "link"),
    ).toMatchObject({ mode: "120000", sha: gitBlobHash(Buffer.from("../outside/secret.txt")) });
    expect(
      entries.some(({ path }) => Buffer.from(path, "base64").toString().includes("secret.txt")),
    ).toBe(false);
    expect(await readFile(marker).catch(() => null)).toBeNull();

    const link = entries.find(({ path }) => Buffer.from(path, "base64").toString() === "link")!;
    const snapshot = await runHelper(workspace, {
      action: "read",
      paths: [link],
    });
    expect(snapshot.code).toBe(0);
    expect(Buffer.from(snapshot.entries![0]!.content!, "base64").toString()).toBe(
      "../outside/secret.txt",
    );
    expect(Buffer.from(snapshot.entries![0]!.content!, "base64").toString()).not.toContain(
      "outside secret",
    );

    const passwdLink = entries.find(
      ({ path }) => Buffer.from(path, "base64").toString() === "passwd-link",
    )!;
    const passwdSnapshot = await runHelper(workspace, {
      action: "read",
      paths: [passwdLink],
    });
    expect(passwdSnapshot.code).toBe(0);
    expect(Buffer.from(passwdSnapshot.entries![0]!.content!, "base64").toString()).toBe(
      "/etc/passwd",
    );
  });

  it("does not hash new paths until canonical ignore filtering has selected them", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sandbox-snapshot-"));
    roots.push(root);
    await writeFile(join(root, "ignored.generated"), "generated content");
    const inventory = await runHelper(root, { action: "inventory", tracked_paths: [] });
    expect(inventory.code).toBe(0);
    expect(inventory.entries).toEqual([
      {
        path: path64("ignored.generated"),
        mode: "100644",
        sha: null,
        size: Buffer.byteLength("generated content"),
      },
    ]);
  });

  it("rejects file bytes that changed after the inventory and refuses symlink-parent traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sandbox-snapshot-"));
    roots.push(root);
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "tracked.txt"), "old");
    await writeFile(join(root, "outside", "secret.txt"), "secret");
    await symlink("outside", join(root, "escape"));

    const inventory = await runHelper(root, {
      action: "inventory",
      tracked_paths: [path64("tracked.txt")],
    });
    const tracked = inventory.entries!.find(
      ({ path }) => Buffer.from(path, "base64").toString() === "tracked.txt",
    )!;
    await writeFile(join(root, "tracked.txt"), "new"); // Same byte length; stat alone would miss it.
    const changed = await runHelper(root, { action: "read", paths: [tracked] });
    expect(changed.code).toBe(1);
    expect(changed.error).toBe("changed_during_read");

    const escaped = await runHelper(root, {
      action: "read",
      paths: [{ path: path64("escape/secret.txt"), mode: "100644", sha: null, size: 6 }],
    });
    expect(escaped.code).toBe(1);
    expect(JSON.stringify(escaped)).not.toContain("secret");
  });

  it("bounds huge trees and tracked-byte scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sandbox-snapshot-"));
    roots.push(root);
    await Promise.all(
      Array.from({ length: 5 }, (_, index) => writeFile(join(root, `file-${index}`), "x")),
    );
    const tooMany = await runHelper(root, { action: "inventory", max_entries: 3 });
    expect(tooMany.code).toBe(1);
    expect(tooMany.error).toBe("too_many_entries");

    const tooLarge = await runHelper(root, {
      action: "inventory",
      tracked_paths: [path64("file-0")],
      max_bytes: 0,
    });
    expect(tooLarge.code).toBe(1);
    expect(tooLarge.error).toBe("scan_too_large");
  });

  it("installs a rebased delta without following an existing sandbox symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sandbox-snapshot-"));
    roots.push(root);
    const outside = join(root, "outside.txt");
    await writeFile(outside, "keep me");
    await symlink(outside, join(root, "escape"));

    const install = await runHelper(root, {
      action: "install",
      delete_paths: [path64("escape")],
      files: [
        {
          path: path64("bin/tool"),
          mode: "100755",
          content: Buffer.from([0, 1, 255]).toString("base64"),
        },
        {
          path: path64("link"),
          mode: "120000",
          content: Buffer.from("../outside.txt").toString("base64"),
        },
      ],
    });
    expect(install.code).toBe(0);
    expect(await readFile(outside, "utf8")).toBe("keep me");
    expect((await readFile(join(root, "bin/tool"))).toString("hex")).toBe("0001ff");
    expect((await lstat(join(root, "bin/tool"))).mode & 0o111).toBeGreaterThan(0);
    expect((await lstat(join(root, "link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(root, "link"))).toBe("../outside.txt");
  });
});
