import { rm } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Remove a purged room's workspace: its sandboxes, its repository and the search checkout kept
 * next to it. Both paths are derived from `workspaceRoot` and the room id only; a recorded
 * `repoPath` that disagrees is refused. Any failure fails the purge, which the sweeper resumes.
 */
export async function purgeRoomWorkspace(options: {
  workspaceRoot: string;
  roomId: string;
  repoPath: string | null | undefined;
  destroyRoom: (roomId: string) => Promise<void>;
}): Promise<void> {
  const { roomId, repoPath } = options;
  await options.destroyRoom(roomId);
  const expectedRepoPath = resolve(options.workspaceRoot, `${roomId}.git`);
  if (repoPath && resolve(repoPath) !== expectedRepoPath) {
    throw new Error(`Refusing to remove unexpected workspace path for ${roomId}`);
  }
  await rm(expectedRepoPath, { recursive: true, force: true });
  // The search checkout is the room's whole file tree (T1636): removed after the repo, errors not swallowed.
  await rm(`${expectedRepoPath}.search`, { recursive: true, force: true });
}
