import type * as NodeCrypto from "node:crypto";
import type * as NodeFs from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import {
  pathGlobMatch as sharedPathGlobMatch,
  wildcardMatch as sharedWildcardMatch,
} from "@crossover/policy";

export const SNAPSHOT_HELPER_LIMITS = {
  maxIgnorePatterns: 1024,
  maxIgnorePatternLength: 1024,
  maxPrunedDirectories: 10_000,
} as const;

type IgnoreRule = { base: string; negated: boolean; pattern: string };

/** Read-only helper that ignores sandbox Git configuration, attributes and hooks. */
async function sandboxSnapshotHelper(
  pathGlobMatch: typeof sharedPathGlobMatch,
  limits: typeof SNAPSHOT_HELPER_LIMITS,
): Promise<void> {
  const fs = process.getBuiltinModule("node:fs/promises") as typeof NodeFsPromises;
  const constants = (process.getBuiltinModule("node:fs") as typeof NodeFs).constants;
  const crypto = process.getBuiltinModule("node:crypto") as typeof NodeCrypto;
  const inputChunks: Buffer[] = [];
  for await (const chunk of process.stdin) inputChunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(inputChunks).toString("utf8")) as {
    action: "inventory" | "read" | "install";
    hash: "sha1" | "sha256";
    tracked_paths?: string[];
    ignore_rules?: { path: string; patterns: string[] }[];
    unprune_directories?: string[];
    paths?: { path: string; mode: string; sha: string | null; size: number }[];
    max_bytes?: number;
    max_entries?: number;
    root?: string;
    files?: { path: string; mode: string; content: string }[];
    delete_paths?: string[];
  };
  const root = await fs.open(
    input.root ?? "/workspace",
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const sameStat = (left: NodeFs.BigIntStats, right: NodeFs.BigIntStats) =>
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
  const objectHash = (bytes: Buffer, format: "sha1" | "sha256") =>
    crypto
      .createHash(format)
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex") as string;
  const checkedPath = (bytes: Buffer): string => {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(`invalid_path_encoding:${text}`);
    if (!text || text.startsWith("/") || /(^|\/)(?:\.|\.\.|\.git|git~1)(?:\/|$)/i.test(text)) {
      throw new Error("invalid_path");
    }
    return text;
  };
  const childPath = (directory: NodeFsPromises.FileHandle, name: Buffer) =>
    Buffer.concat([Buffer.from(`/proc/self/fd/${directory.fd}/`), name]);
  const gitMode = (stat: NodeFs.BigIntStats): string =>
    stat.isSymbolicLink() ? "120000" : (stat.mode & 0o111n) !== 0n ? "100755" : "100644";
  try {
    if (input.action === "inventory") {
      const tracked = new Set(input.tracked_paths ?? []);
      const unpruneDirectories = new Set(input.unprune_directories ?? []);
      if (unpruneDirectories.size > limits.maxPrunedDirectories) throw new Error("invalid_request");
      for (const path of unpruneDirectories) {
        const bytes = Buffer.from(path, "base64");
        if (bytes.toString("base64") !== path) throw new Error("invalid_request");
        checkedPath(bytes);
      }
      const trackedDirectories = new Set<string>();
      for (const path of tracked) {
        const decoded = Buffer.from(path, "base64").toString("utf8");
        for (let slash = decoded.indexOf("/"); slash >= 0; slash = decoded.indexOf("/", slash + 1))
          trackedDirectories.add(Buffer.from(decoded.slice(0, slash)).toString("base64"));
      }
      const ignoreRules: IgnoreRule[] = [];
      let patternCount = 0;
      for (const { path, patterns } of input.ignore_rules ?? []) {
        const base =
          path === ".roomignore" || path === ".gitignore"
            ? ""
            : path.slice(0, -10).replace(/\/$/, "");
        for (const line of patterns) {
          if (
            ++patternCount > limits.maxIgnorePatterns ||
            line.length > limits.maxIgnorePatternLength
          )
            throw new Error("ignore_rules_too_large");
          if (!line || line.startsWith("#")) continue;
          const negated = line.startsWith("!") && !line.startsWith("\\!");
          let pattern = negated ? line.slice(1) : line.replace(/^\\([#!])/, "$1");
          if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
          const anchored = pattern.startsWith("/");
          if (anchored) pattern = pattern.slice(1);
          if (!pattern) continue;
          const basenameOnly = !anchored && !pattern.includes("/");
          pattern = pattern
            .split("/")
            .map((segment) =>
              segment === "**" && !basenameOnly ? segment : segment.replace(/\*{2,}/g, "*"),
            )
            .join("/");
          if (basenameOnly) pattern = `**/${pattern}`;
          ignoreRules.push({ base, negated, pattern });
        }
      }
      const isIgnored = (path: string) => {
        let ignored = false;
        for (const rule of ignoreRules) {
          if (rule.base && !path.startsWith(`${rule.base}/`)) continue;
          const relative = rule.base ? path.slice(rule.base.length + 1) : path;
          if (pathGlobMatch(rule.pattern, relative)) ignored = !rule.negated;
        }
        return ignored;
      };
      const entries: { path: string; mode: string; sha: string | null; size: number }[] = [];
      const prunedDirectories: string[] = [];
      const prune = (ignored: boolean, path: string) => {
        if (!ignored || tracked.has(path) || trackedDirectories.has(path)) return false;
        if (prunedDirectories.push(path) > limits.maxPrunedDirectories)
          throw new Error("too_many_pruned_directories");
        return true;
      };
      let scannedBytes = 0;
      const walk = async (
        directory: NodeFsPromises.FileHandle,
        prefix: Buffer,
        ignoredParent = false,
        unprunedParent = false,
      ): Promise<void> => {
        const beforeDir = await directory.stat({ bigint: true });
        const listing = await fs.opendir(`/proc/self/fd/${directory.fd}`, {
          encoding: "buffer",
        } as never);
        for await (const dirent of listing) {
          const name = Buffer.isBuffer(dirent.name) ? dirent.name : Buffer.from(dirent.name);
          if (/^(?:\.git|git~1)$/i.test(name.toString("utf8"))) continue;
          const relative = prefix.length ? Buffer.concat([prefix, Buffer.from("/"), name]) : name;
          checkedPath(relative);
          const encodedPath = relative.toString("base64");
          const path = relative.toString("utf8");
          const directoryEntry = dirent.isDirectory();
          const target = childPath(directory, name);
          const unpruned = unprunedParent || unpruneDirectories.has(encodedPath);
          let ignored = unpruned ? false : ignoredParent;
          if (directoryEntry && !unpruned) {
            ignored ||= isIgnored(path);
            if (prune(ignored, encodedPath)) continue;
          }
          const before = await fs.lstat(target, { bigint: true });
          if (before.isDirectory()) {
            if (!directoryEntry && !unpruned) {
              ignored ||= isIgnored(path);
              if (prune(ignored, encodedPath)) continue;
            }
            const child = await fs.open(
              target,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            try {
              const opened = await child.stat({ bigint: true });
              if (!sameStat(before, opened)) throw new Error("changed_during_read");
              await walk(child, relative, unpruned ? false : ignoredParent || ignored, unpruned);
            } finally {
              await child.close();
            }
            continue;
          }
          let size: number;
          let sha: string | null = null;
          if (before.isSymbolicLink()) {
            const bytes = (await fs.readlink(target, {
              encoding: "buffer",
            } as never)) as unknown as Buffer;
            const after = await fs.lstat(target, { bigint: true });
            if (!sameStat(before, after)) throw new Error("changed_during_read");
            size = bytes.length;
            if (tracked.has(encodedPath)) sha = objectHash(bytes, input.hash);
          } else if (before.isFile()) {
            if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("file_too_large");
            size = Number(before.size);
            if (tracked.has(encodedPath)) {
              scannedBytes += size;
              if (scannedBytes > (input.max_bytes ?? 1024 * 1024 * 1024))
                throw new Error("scan_too_large");
              const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const opened = await file.stat({ bigint: true });
                if (!sameStat(before, opened)) throw new Error("changed_during_read");
                const hash = crypto.createHash(input.hash);
                hash.update(`blob ${size}\0`);
                const chunk = Buffer.allocUnsafe(64 * 1024);
                let length = 0;
                for (;;) {
                  const result = await file.read(chunk, 0, chunk.length, null);
                  if (!result.bytesRead) break;
                  length += result.bytesRead;
                  hash.update(chunk.subarray(0, result.bytesRead));
                }
                const after = await file.stat({ bigint: true });
                if (!sameStat(opened, after) || length !== size)
                  throw new Error("changed_during_read");
                sha = hash.digest("hex") as string;
              } finally {
                await file.close();
              }
            }
          } else {
            throw new Error("unsupported_file_type");
          }
          entries.push({
            path: relative.toString("base64"),
            mode: gitMode(before),
            sha,
            size,
          });
          if (entries.length > (input.max_entries ?? 100_000)) throw new Error("too_many_entries");
        }
        const afterDir = await directory.stat({ bigint: true });
        if (!ignoredParent && !sameStat(beforeDir, afterDir))
          throw new Error("changed_during_read");
      };
      await walk(root, Buffer.alloc(0));
      process.stdout.write(JSON.stringify({ entries, pruned_directories: prunedDirectories }));
      return;
    }
    if (input.action === "install") {
      const openParent = async (
        encodedPath: string,
      ): Promise<{
        directory: NodeFsPromises.FileHandle;
        name: Buffer;
        opened: NodeFsPromises.FileHandle[];
      }> => {
        const pathBytes = Buffer.from(encodedPath, "base64");
        checkedPath(pathBytes);
        const parts = pathBytes
          .toString("utf8")
          .split("/")
          .map((part) => Buffer.from(part));
        let directory = root;
        const opened: NodeFsPromises.FileHandle[] = [];
        for (const part of parts.slice(0, -1)) {
          const target = childPath(directory, part);
          let next: NodeFsPromises.FileHandle;
          try {
            next = await fs.open(
              target,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await fs.mkdir(target, { mode: 0o755 });
            next = await fs.open(
              target,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
          }
          opened.push(next);
          directory = next;
        }
        return { directory, name: parts.at(-1)!, opened };
      };
      for (const path of input.delete_paths ?? []) {
        const parent = await openParent(path);
        try {
          const target = childPath(parent.directory, parent.name);
          try {
            await fs.unlink(target);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "EISDIR" || code === "EPERM") await fs.rmdir(target);
            else if (code !== "ENOENT") throw error;
          }
        } finally {
          for (const opened of parent.opened.reverse()) await opened.close();
        }
      }
      for (const file of input.files ?? []) {
        const parent = await openParent(file.path);
        const temporary = Buffer.from(
          `.crossover-submit-${crypto.randomBytes(12).toString("hex")}`,
        );
        const temporaryPath = childPath(parent.directory, temporary);
        const targetPath = childPath(parent.directory, parent.name);
        try {
          const content = Buffer.from(file.content, "base64");
          if (content.toString("base64") !== file.content) throw new Error("invalid_request");
          if (file.mode === "120000") {
            await fs.symlink(content, temporaryPath);
          } else if (file.mode === "100644" || file.mode === "100755") {
            const output = await fs.open(
              temporaryPath,
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
              file.mode === "100755" ? 0o755 : 0o644,
            );
            try {
              await output.writeFile(content);
            } finally {
              await output.close();
            }
          } else {
            throw new Error("invalid_request");
          }
          await fs.rename(temporaryPath, targetPath);
        } finally {
          await fs.unlink(temporaryPath).catch(() => undefined);
          for (const opened of parent.opened.reverse()) await opened.close();
        }
      }
      process.stdout.write(JSON.stringify({ installed: true }));
      return;
    }

    if (input.action !== "read" || !Array.isArray(input.paths)) throw new Error("invalid_request");
    const maxBytes = input.max_bytes ?? 25 * 1024 * 1024;
    let totalBytes = 0;
    const entries: {
      path: string;
      mode: string;
      sha: string;
      size: number;
      content: string;
    }[] = [];
    for (const expected of input.paths) {
      const pathBytes = Buffer.from(expected.path, "base64");
      checkedPath(pathBytes);
      const parts = pathBytes
        .toString("utf8")
        .split("/")
        .map((part) => Buffer.from(part));
      let directory = root;
      const openedDirectories: NodeFsPromises.FileHandle[] = [];
      try {
        for (const part of parts.slice(0, -1)) {
          const next = await fs.open(
            childPath(directory, part),
            constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          );
          openedDirectories.push(next);
          directory = next;
        }
        const target = childPath(directory, parts.at(-1)!);
        const before = await fs.lstat(target, { bigint: true });
        let bytes: Buffer;
        if (before.isSymbolicLink()) {
          bytes = (await fs.readlink(target, { encoding: "buffer" } as never)) as unknown as Buffer;
          const after = await fs.lstat(target, { bigint: true });
          if (!sameStat(before, after)) throw new Error("changed_during_read");
        } else if (before.isFile()) {
          if (before.size > BigInt(maxBytes - totalBytes)) throw new Error("too_large");
          const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const opened = await file.stat({ bigint: true });
            if (!sameStat(before, opened)) throw new Error("changed_during_read");
            bytes = await file.readFile();
            const after = await file.stat({ bigint: true });
            if (!sameStat(opened, after)) throw new Error("changed_during_read");
          } finally {
            await file.close();
          }
        } else {
          throw new Error("unsupported_file_type");
        }
        const mode = gitMode(before);
        const sha = objectHash(bytes, input.hash);
        if (
          mode !== expected.mode ||
          (expected.sha !== null && sha !== expected.sha) ||
          bytes.length !== expected.size
        )
          throw new Error("changed_during_read");
        totalBytes += bytes.length;
        if (totalBytes > maxBytes) throw new Error("too_large");
        entries.push({
          path: expected.path,
          mode,
          sha,
          size: bytes.length,
          content: bytes.toString("base64"),
        });
      } finally {
        for (const opened of openedDirectories.reverse()) await opened.close();
      }
    }
    process.stdout.write(JSON.stringify({ entries }));
  } finally {
    await root.close();
  }
}

export const SANDBOX_SNAPSHOT_HELPER = `const wildcardMatch = ${sharedWildcardMatch.toString()};
const pathGlobMatch = ${sharedPathGlobMatch.toString()};
(${sandboxSnapshotHelper.toString()})(pathGlobMatch, ${JSON.stringify(SNAPSHOT_HELPER_LIMITS)}).catch((error) => {
  const code = typeof error?.message === "string" ? error.message : "snapshot_failed";
  process.stdout.write(JSON.stringify({ error: code }));
  process.exitCode = 1;
});`;
