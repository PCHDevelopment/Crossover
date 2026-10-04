import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { git, GitError } from "./git.js";

const CANONICAL_REF = "refs/room/canonical";
const TIMEOUT_MS = 10_000;

/** Initialize a room's bare repository and return its absolute path (§9.1). */
export async function initRoomRepo(workspaceRoot: string, roomId: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) {
    throw new TypeError("roomId must be a nonempty identifier without path separators");
  }
  const repo = resolve(workspaceRoot, `${roomId}.git`);
  await mkdir(resolve(workspaceRoot), { recursive: true });
  // An explicit empty template prevents host templates from installing hooks.
  await git(["init", "--bare", "--template=", repo], { timeoutMs: TIMEOUT_MS });
  const options = { gitDir: repo, timeoutMs: TIMEOUT_MS };
  try {
    await git(["show-ref", "--verify", "--quiet", CANONICAL_REF], options);
    return repo;
  } catch (error) {
    if (!(error instanceof GitError) || error.exitCode !== 1) throw error;
  }

  const { stdout: tree } = await git(["mktree"], { ...options, input: "" });
  const { stdout: commit } = await git(["commit-tree", tree.trim()], {
    ...options,
    input: "Initialize room workspace\n",
    env: {
      GIT_AUTHOR_NAME: "Crossover",
      GIT_AUTHOR_EMAIL: "system@crossover.local",
      GIT_COMMITTER_NAME: "Crossover",
      GIT_COMMITTER_EMAIL: "system@crossover.local",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
  });
  // Create only: never reset an existing canonical head, even if it appeared meanwhile.
  try {
    await git(["update-ref", CANONICAL_REF, commit.trim(), ""], options);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    await git(["show-ref", "--verify", "--quiet", CANONICAL_REF], options);
  }
  return repo;
}
