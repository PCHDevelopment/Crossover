import { withTransaction, type Pool } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import { git, GitError } from "./git.js";

/** Guard the post-commit cache update against a lagging or unexpectedly changed ref (§19.4). */
export async function updateCanonicalRef(
  repo: string,
  commit: string,
  expected: string,
): Promise<void> {
  await git(["update-ref", "refs/room/canonical", commit, expected], {
    gitDir: repo,
    timeoutMs: 10_000,
  });
}

/** Recover a room on ownership acquisition before its first command (§19.4/§26; T712 wiring). */
export async function reconcileRef(pool: Pool, roomId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Appliers take this same lock: no DB head can advance during selection and ref repair.
    const { rows } = await client.query<{ id: string; repo_path: string }>(
      "SELECT id, repo_path FROM workspaces WHERE room_id = $1 FOR UPDATE",
      [roomId],
    );
    const ws = rows[0];
    if (!ws) throw new CrossoverError("NOT_FOUND", "Workspace not provisioned");
    const head = await client.query<{ commit_sha: string }>(
      `SELECT commit_sha FROM workspace_revisions WHERE room_id = $1 AND workspace_id = $2
       ORDER BY revision DESC LIMIT 1`,
      [roomId, ws.id],
    );
    if (!head.rows[0]) throw new CrossoverError("NOT_FOUND", "Workspace history missing");
    let current = "";
    try {
      current = (
        await git(["rev-parse", "--verify", "--quiet", "refs/room/canonical"], {
          gitDir: ws.repo_path,
          timeoutMs: 10_000,
        })
      ).stdout.trim();
    } catch (error) {
      if (!(error instanceof GitError) || error.exitCode !== 1 || error.timedOut || error.signal)
        throw error;
    }
    if (current !== head.rows[0].commit_sha)
      await updateCanonicalRef(ws.repo_path, head.rows[0].commit_sha, current);
  });
}
