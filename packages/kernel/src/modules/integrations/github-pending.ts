/** A repository returned by GitHub's user-authorized installation endpoint. */
export interface GitHubPendingRepository {
  name: string;
  id: string;
}

/** A verified installation selection, short-lived and bound to its room owner. */
export interface GitHubPendingConnection {
  room_id: string;
  owner_participant_id: string;
  installation_id: string;
  repositories: readonly GitHubPendingRepository[];
  expires_at: string;
}

/** Storage for one-use installation records; implementations must enforce the supplied binding. */
export interface GitHubPendingConnectionStore {
  save(pendingId: string, value: GitHubPendingConnection): Promise<void>;
  peek(
    pendingId: string,
    binding: { room_id: string; owner_participant_id: string },
  ): Promise<GitHubPendingConnection | undefined>;
  consume(
    pendingId: string,
    binding: { room_id: string; owner_participant_id: string },
  ): Promise<GitHubPendingConnection | undefined>;
}
