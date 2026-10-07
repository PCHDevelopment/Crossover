import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { git } from "./git.js";

const queues = new Map<string, Promise<unknown>>();

async function queued<T>(repo: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(repo) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  queues.set(repo, next);
  try {
    return await next;
  } finally {
    if (queues.get(repo) === next) queues.delete(repo);
  }
}

async function cacheState(repo: string) {
  const cache = `${repo}.search`;
  const tree = join(cache, "tree");
  await mkdir(cache, { recursive: true });
  let cached = "";
  try {
    cached = await readFile(join(cache, "commit"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let present = false;
  try {
    present = (await stat(tree)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { cache, tree, cached, present };
}

async function replaceTree(repo: string, commit: string, cache: string, tree: string) {
  const staging = await mkdtemp(join(cache, "staging-"));
  try {
    const checkout = join(staging, "tree");
    await mkdir(checkout);
    const options = {
      gitDir: repo,
      timeoutMs: 10_000,
      env: { GIT_INDEX_FILE: join(staging, "index") },
    };
    await git(["read-tree", commit], options);
    await git([`--work-tree=${checkout}`, "checkout-index", "--all", "--force"], options);
    await rm(tree, { recursive: true, force: true });
    await rename(checkout, tree);
    await writeFile(join(cache, "commit"), commit);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function pruneEmptyParents(tree: string, path: string) {
  let directory = dirname(join(tree, path));
  while (directory !== tree && directory.startsWith(`${tree}/`)) {
    try {
      await rmdir(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
      if (code !== "ENOENT") break;
    }
    directory = dirname(directory);
  }
}

async function updateChangedPaths(
  repo: string,
  previousCommit: string,
  commit: string,
  tree: string,
): Promise<void> {
  const { stdout } = await git(
    [
      "diff-tree",
      "--no-commit-id",
      "--raw",
      "--no-abbrev",
      "-r",
      "-z",
      "--no-renames",
      previousCommit,
      commit,
    ],
    { gitDir: repo, timeoutMs: 10_000 },
  );
  const records = stdout.split("\0");
  if (records.at(-1) === "") records.pop();
  const changed: { status: string; path: string; mode: string; oid: string }[] = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const metadata = records[i]!.trim().split(/\s+/);
    const path = records[i + 1]!;
    const [oldMode, mode, oldOid, oid, status] = metadata;
    if (
      !metadata[0]?.startsWith(":") ||
      !oldMode ||
      !mode ||
      !oldOid ||
      !oid ||
      !/^[AMDTUXB](?:\d+)?$/.test(status ?? "") ||
      path.startsWith("/") ||
      path.split("/").includes("..")
    )
      throw new Error("Unexpected Git path in search-tree refresh");
    changed.push({ status: status!, path, mode: mode!, oid: oid! });
  }
  if (records.length % 2 !== 0) throw new Error("Malformed Git path list in search-tree refresh");
  const insideTree = (path: string) => {
    const target = resolve(tree, path);
    if (!target.startsWith(`${resolve(tree)}/`))
      throw new Error("Git path escaped the search tree");
    return target;
  };
  for (const { status, path } of changed) {
    await rm(insideTree(path), { recursive: true, force: true });
    if (status === "D") await pruneEmptyParents(tree, path);
  }

  const blobs = changed.filter(({ oid }) => !/^0+$/.test(oid));
  if (blobs.length === 0) return;
  const { stdout: batch } = await git(["cat-file", "--batch"], {
    gitDir: repo,
    timeoutMs: 10_000,
    encoding: "buffer",
    input: blobs.map(({ oid }) => oid).join("\n") + "\n",
  });
  let offset = 0;
  for (const file of blobs) {
    const headerEnd = batch.indexOf(10, offset);
    if (headerEnd < 0) throw new Error("Malformed Git object batch in search-tree refresh");
    const [oid, type, sizeValue] = batch.subarray(offset, headerEnd).toString("utf8").split(" ");
    const size = Number(sizeValue);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (
      oid !== file.oid ||
      type !== "blob" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      batch[contentEnd] !== 10
    )
      throw new Error("Malformed Git object batch in search-tree refresh");
    const target = insideTree(file.path);
    const content = batch.subarray(contentStart, contentEnd);
    await mkdir(dirname(target), { recursive: true });
    if (file.mode === "120000") {
      await symlink(content.toString("utf8"), target);
    } else if (file.mode === "160000") {
      await mkdir(target, { recursive: true });
    } else if (file.mode === "100644" || file.mode === "100755") {
      await writeFile(target, content);
      await chmod(target, file.mode === "100755" ? 0o755 : 0o644);
    } else {
      throw new Error("Unsupported Git file mode in search-tree refresh");
    }
    offset = contentEnd + 1;
  }
}

/** Serialize checkout refresh and readers on the workspace owner (§9.5); commit comes from DB. */
export async function withSearchTree<T>(
  repo: string,
  commit: string,
  read: (tree: string) => Promise<T>,
): Promise<T> {
  return queued(repo, async () => {
    const { cache, tree, cached, present } = await cacheState(repo);
    if (cached !== commit || !present) await replaceTree(repo, commit, cache, tree);
    return read(tree);
  });
}

/** Refresh a direct child commit by touching only its changed paths; repair stale caches fully. */
export async function refreshSearchTree(
  repo: string,
  commit: string,
  previousCommit?: string,
): Promise<void> {
  await queued(repo, async () => {
    const { cache, tree, cached, present } = await cacheState(repo);
    if (cached === commit && present) return;
    if (previousCommit && cached === previousCommit && present) {
      try {
        await updateChangedPaths(repo, previousCommit, commit, tree);
        await writeFile(join(cache, "commit"), commit);
        return;
      } catch (error) {
        // A cache that no longer matches the expected parent, or a large/unusual diff, is rebuilt.
        console.warn("Incremental search-tree refresh failed; rebuilding cache", error);
      }
    }
    await replaceTree(repo, commit, cache, tree);
  });
}
