import type { Dispatch, SetStateAction } from "react";

export interface RoomIntegration {
  provider: string;
  status: string;
  status_reason: string | null;
  config?: Record<string, unknown>;
}

export function IntegrationsSection({
  busy,
  githubIntegration,
  githubPendingId,
  pendingRepositories,
  selectedRepositories,
  pendingRepositoriesLoading,
  setSelectedRepositories,
  startGitHubInstall,
  verifyGitHub,
  disconnectGitHub,
  connectGitHub,
}: {
  busy: boolean;
  githubIntegration: RoomIntegration | undefined;
  githubPendingId: string | undefined;
  pendingRepositories: string[];
  selectedRepositories: string[];
  pendingRepositoriesLoading: boolean;
  setSelectedRepositories: Dispatch<SetStateAction<string[]>>;
  startGitHubInstall: () => void;
  verifyGitHub: () => void;
  disconnectGitHub: () => void;
  connectGitHub: () => void;
}) {
  return (
    <section aria-label="Integrations" data-testid="owner-integrations">
      <h3>Integrations</h3>
      <h4>GitHub</h4>
      <p>
        Status:{" "}
        <strong data-testid="github-integration-status">
          {githubIntegration?.status ?? "Not connected"}
        </strong>
        {githubIntegration?.status_reason ? ` · ${githubIntegration.status_reason}` : ""}
      </p>
      {Array.isArray(githubIntegration?.config?.["repositories"]) && (
        <p data-testid="github-connected-repositories">
          Repositories: {(githubIntegration.config["repositories"] as string[]).join(", ")}
        </p>
      )}
      <button
        type="button"
        data-testid="github-connect"
        disabled={busy}
        onClick={startGitHubInstall}
      >
        Connect GitHub
      </button>{" "}
      {githubIntegration?.status === "CONNECTED" && (
        <>
          <button type="button" data-testid="github-verify" disabled={busy} onClick={verifyGitHub}>
            Verify
          </button>{" "}
        </>
      )}
      {githubIntegration && (
        <button
          type="button"
          data-testid="github-disconnect"
          disabled={busy}
          onClick={disconnectGitHub}
        >
          Disconnect
        </button>
      )}
      {githubPendingId && (
        <div data-testid="github-repository-picker">
          <h4>Choose repositories</h4>
          {pendingRepositoriesLoading ? (
            <p className="muted">Loading repositories…</p>
          ) : pendingRepositories.length === 0 ? (
            <p className="muted">
              No verified repositories are available. Start the connection again.
            </p>
          ) : (
            <fieldset disabled={busy}>
              <legend>Allow Crossover to use these repositories</legend>
              {pendingRepositories.map((repository) => (
                <label key={repository}>
                  <input
                    type="checkbox"
                    data-testid="github-repository-option"
                    checked={selectedRepositories.includes(repository)}
                    onChange={(event) =>
                      setSelectedRepositories((selected) =>
                        event.target.checked
                          ? [...selected, repository]
                          : selected.filter((name) => name !== repository),
                      )
                    }
                  />
                  {repository}
                </label>
              ))}
            </fieldset>
          )}
          <button
            type="button"
            data-testid="github-connect-selected"
            disabled={busy || pendingRepositoriesLoading || selectedRepositories.length === 0}
            onClick={connectGitHub}
          >
            Connect selected repositories
          </button>
        </div>
      )}
    </section>
  );
}
