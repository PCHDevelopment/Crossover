import type * as NodeCrypto from "node:crypto";
import type * as NodeFs from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";

/**
 * Code run by a short-lived, read-only Docker helper to inspect a sandbox volume. It intentionally
 * uses only Node's filesystem APIs: the sandbox's .git/config, attributes and executable hooks are
 * never consulted. The helper is also executed by tests with a temporary directory as its root.
 */
async function sandboxSnapshotHelper(): Promise<void> {
  const fs = process.getBuiltinModule("node:fs/promises") as typeof NodeFsPromises;
  const constants = (process.getBuiltinModule("node:fs") as typeof NodeFs).constants;
  const crypto = process.getBuiltinModule("node:crypto") as typeof NodeCrypto;
  const inputChunks: Buffer[] = [];
  for await (const chunk of process.stdin) inputChunks.push(Buffer.from(chunk));
  const input = JSON.parse(Buffer.concat(inputChunks).toString("utf8")) as {
    action: "inventory" | "read" | "install";
    hash: "sha1" | "sha256";
    tracked_paths?: string[];
    paths?: { path: string; mode: string; sha: string | null; size: number }[];
    max_bytes?: number;
    max_entries?: number;
    root?: string;
    files?: { path: string; mode: string; content: string }[];
    delete_paths?: string[];
  };
  const rootPath = input.root ?? "/workspace";
  const root = await fs.open(
    rootPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const maxEntries = input.max_entries ?? 100_000;

  const sameStat = (left: NodeFs.BigIntStats, right: NodeFs.BigIntStats) =>
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
  const objectHash = (bytes: Buffer, format: "sha1" | "sha256") => {
    const hash = crypto.createHash(format);
    hash.update(`blob ${bytes.length}\0`);
    hash.update(bytes);
    return hash.digest("hex") as string;
  };
  const checkedPath = (bytes: Buffer): string => {
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("invalid_path_encoding");
    const parts = text.split("/");
    if (
      !text ||
      text.startsWith("/") ||
      parts.some(
        (part) => !part || part === "." || part === ".." || /^(?:\.git|git~1)$/i.test(part),
      )
    ) {
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
      const entries: { path: string; mode: string; sha: string | null; size: number }[] = [];
      let scannedBytes = 0;
      const walk = async (directory: NodeFsPromises.FileHandle, prefix: Buffer): Promise<void> => {
        const beforeDir = await directory.stat({ bigint: true });
        const listing = await fs.opendir(`/proc/self/fd/${directory.fd}`, {
          encoding: "buffer",
        } as never);
        for await (const dirent of listing) {
          const name = Buffer.isBuffer(dirent.name) ? dirent.name : Buffer.from(dirent.name);
          if (/^(?:\.git|git~1)$/i.test(name.toString("utf8"))) continue;
          const relative = prefix.length ? Buffer.concat([prefix, Buffer.from("/"), name]) : name;
          checkedPath(relative);
          const target = childPath(directory, name);
          const before = await fs.lstat(target, { bigint: true });
          if (before.isDirectory()) {
            const child = await fs.open(
              target,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            );
            try {
              const opened = await child.stat({ bigint: true });
              if (!sameStat(before, opened)) throw new Error("changed_during_read");
              await walk(child, relative);
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
            if (tracked.has(relative.toString("base64"))) sha = objectHash(bytes, input.hash);
          } else if (before.isFile()) {
            if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("file_too_large");
            size = Number(before.size);
            if (tracked.has(relative.toString("base64"))) {
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
          if (entries.length > maxEntries) throw new Error("too_many_entries");
        }
        const afterDir = await directory.stat({ bigint: true });
        if (!sameStat(beforeDir, afterDir)) throw new Error("changed_during_read");
      };
      await walk(root, Buffer.alloc(0));
      process.stdout.write(JSON.stringify({ entries }));
      return;
    }

    if (input.action === "install") {
      const openParent = async (
        encodedPath: string,
      ): Promise<{
        directory: NodeFsPromises.FileHandle;
        name: Buffer;
        opened: NodeFsPromises.FileHandle[];
        ancestors: {
          parent: NodeFsPromises.FileHandle;
          name: Buffer;
        }[];
      }> => {
        const pathBytes = Buffer.from(encodedPath, "base64");
        checkedPath(pathBytes);
        const parts = pathBytes
          .toString("utf8")
          .split("/")
          .map((part) => Buffer.from(part));
        let directory = root;
        const opened: NodeFsPromises.FileHandle[] = [];
        const ancestors: {
          parent: NodeFsPromises.FileHandle;
          name: Buffer;
        }[] = [];
        for (const part of parts.slice(0, -1)) {
          const parent = directory;
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
          ancestors.push({ parent, name: part });
          directory = next;
        }
        return { directory, name: parts.at(-1)!, opened, ancestors };
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
          for (const ancestor of parent.ancestors.reverse()) {
            try {
              await fs.rmdir(childPath(ancestor.parent, ancestor.name));
            } catch (error) {
              const code = (error as NodeJS.ErrnoException).code;
              if (code === "ENOENT") continue;
              if (code === "ENOTEMPTY" || code === "EEXIST") break;
              throw error;
            }
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

/** Standalone script for `node -e`; keep it free of module-scope dependencies. */
export const SANDBOX_SNAPSHOT_HELPER = `(${sandboxSnapshotHelper.toString()})().catch((error) => {
  const code = typeof error?.message === "string" ? error.message : "snapshot_failed";
  process.stdout.write(JSON.stringify({ error: code }));
  process.exitCode = 1;
});`;
