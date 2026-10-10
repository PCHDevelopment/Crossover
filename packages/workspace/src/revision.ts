import type { PoolClient } from "@crossover/db";

export type AfterCommit = (callback: () => void | Promise<void>) => void;

export interface WorkspaceRevisionInput {
  workspace_id: string;
  room_id: string;
  revision: number;
  commit_sha: string;
  changeset_id?: string;
}

/** The only write path for canonical revision rows; advances enqueue work after their commit. */
export async function recordWorkspaceRevision(
  client: PoolClient,
  input: WorkspaceRevisionInput,
  options: {
    afterCommit?: AfterCommit;
    scheduleSandboxAdvance?: (roomId: string, revision: number) => void;
    onConflict?: "ignore";
  } = {},
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha, changeset_id)
     VALUES ($1, $2, $3, $4, $5)${options.onConflict === "ignore" ? " ON CONFLICT (workspace_id, revision) DO NOTHING" : ""}`,
    [
      input.workspace_id,
      input.room_id,
      input.revision,
      input.commit_sha,
      input.changeset_id ?? null,
    ],
  );
  if (input.revision > 0 && options.afterCommit && options.scheduleSandboxAdvance) {
    options.afterCommit(() => options.scheduleSandboxAdvance!(input.room_id, input.revision));
  }
}
