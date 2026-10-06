import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.js";

const queues = new Map<string, Promise<unknown>>();

/** Serialize checkout refresh and readers on the workspace owner (§9.5); commit comes from DB. */
export async function withSearchTree<T>(
  repo: string,
  commit: string,
  read: (tree: string) => Promise<T>,
): Promise<T> {
  const previous = queues.get(repo) ?? Promise.resolve();
  const work = previous
    .catch(() => {})
    .then(async () => {
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
      if (cached !== commit || !present) {
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
      return read(tree);
    });
  queues.set(repo, work);
  try {
    return await work;
  } finally {
    if (queues.get(repo) === work) queues.delete(repo);
  }
}
