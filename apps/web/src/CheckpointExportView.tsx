import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { RoomClient, SdkEvent } from "@crossover/sdk";

interface Checkpoint {
  id: string;
  revision: number;
  message: string;
  created_by: string;
  health_status: "GREEN" | "RED" | "ERROR" | "PENDING" | null;
  overridden: boolean;
}

interface ExportResult {
  branch: string;
  pull_request?: { url: string; number: number };
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";

export default function CheckpointExportView(props: {
  room: RoomClient;
  mayManageDelivery: boolean;
  nameOf: (id: string) => string;
  onEvent: (listener: (event: SdkEvent) => void) => () => void;
}) {
  const { room, mayManageDelivery, nameOf, onEvent } = props;
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [checkpointMessage, setCheckpointMessage] = useState("");
  const [selectedCheckpoint, setSelectedCheckpoint] = useState("");
  const [openPullRequest, setOpenPullRequest] = useState(false);
  const [pullRequestTitle, setPullRequestTitle] = useState("");
  const [exportResult, setExportResult] = useState<ExportResult>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  const loadCheckpoints = useCallback(async () => {
    const page = await room.api.checkpoints.list<{
      checkpoints: Checkpoint[];
      has_more: boolean;
    }>({ limit: 100 });
    setCheckpoints(page.response.checkpoints);
    setSelectedCheckpoint((current) =>
      page.response.checkpoints.some((checkpoint) => checkpoint.id === current)
        ? current
        : (page.response.checkpoints.at(-1)?.id ?? ""),
    );
  }, [room]);

  useEffect(() => {
    void loadCheckpoints().catch((error: unknown) => setNotice(errorMessage(error)));
  }, [loadCheckpoints]);

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === "checkpoint.created" || event.type === "checkpoint.exported") {
          void loadCheckpoints().catch((error: unknown) => setNotice(errorMessage(error)));
        }
      }),
    [loadCheckpoints, onEvent],
  );

  const createCheckpoint = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = checkpointMessage.trim();
    if (!text) return;
    setBusy(true);
    setNotice(undefined);
    setExportResult(undefined);
    try {
      const created = await room.api.checkpoints.create<Checkpoint>({ message: text });
      setCheckpointMessage("");
      setSelectedCheckpoint(created.response.id);
      await loadCheckpoints();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const exportCheckpoint = async () => {
    const checkpointId = selectedCheckpoint || checkpoints.at(-1)?.id;
    if (!checkpointId) return;
    setBusy(true);
    setNotice(undefined);
    setExportResult(undefined);
    try {
      const pullRequest = openPullRequest
        ? { ...(pullRequestTitle.trim() ? { title: pullRequestTitle.trim() } : {}) }
        : undefined;
      const result = await room.api.checkpoints.export<ExportResult>({
        checkpoint_id: checkpointId,
        ...(pullRequest ? { pull_request: pullRequest } : {}),
      });
      setExportResult(result.response);
      await loadCheckpoints();
    } catch (error) {
      // The export API returns provider errors with credentials removed; show only its message.
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="delivery-section" aria-label="Checkpoints and export">
      <h2>Checkpoints and export</h2>
      {notice && (
        <p role="alert" className="error" data-testid="delivery-notice">
          {notice}
        </p>
      )}
      {mayManageDelivery ? (
        <>
          <form onSubmit={(event) => void createCheckpoint(event)}>
            <label>
              Checkpoint message
              <input
                data-testid="checkpoint-message"
                value={checkpointMessage}
                onChange={(event) => setCheckpointMessage(event.target.value)}
                maxLength={500}
                required
              />
            </label>
            <button data-testid="create-checkpoint" disabled={busy}>
              Create checkpoint
            </button>
          </form>
          <label>
            Export checkpoint
            <select
              data-testid="export-checkpoint-select"
              value={selectedCheckpoint}
              onChange={(event) => setSelectedCheckpoint(event.target.value)}
              disabled={checkpoints.length === 0 || busy}
            >
              {checkpoints.length === 0 && <option value="">No checkpoints yet</option>}
              {checkpoints.map((checkpoint) => (
                <option key={checkpoint.id} value={checkpoint.id}>
                  Revision {checkpoint.revision}: {checkpoint.message}
                </option>
              ))}
            </select>
          </label>
          <ul className="list checkpoint-list" data-testid="checkpoint-list">
            {checkpoints.map((checkpoint) => (
              <li key={checkpoint.id} data-testid="checkpoint" data-id={checkpoint.id}>
                <strong>Revision {checkpoint.revision}</strong>: {checkpoint.message}
                <span className="muted"> · {nameOf(checkpoint.created_by)}</span>
                {checkpoint.health_status && (
                  <span className="badge">Health {checkpoint.health_status}</span>
                )}
                {checkpoint.overridden && <span className="badge">Health override</span>}
              </li>
            ))}
            {checkpoints.length === 0 && <li className="muted">No checkpoints yet.</li>}
          </ul>
          <label className="inline-option">
            <input
              type="checkbox"
              data-testid="export-open-pull-request"
              checked={openPullRequest}
              onChange={(event) => setOpenPullRequest(event.target.checked)}
              disabled={busy}
            />
            Open a pull request
          </label>
          {openPullRequest && (
            <label>
              Pull request title (optional)
              <input
                data-testid="pull-request-title"
                value={pullRequestTitle}
                onChange={(event) => setPullRequestTitle(event.target.value)}
                maxLength={200}
              />
            </label>
          )}
          <button
            data-testid="export-checkpoint"
            disabled={checkpoints.length === 0 || busy}
            onClick={() => void exportCheckpoint()}
          >
            Export checkpoint
          </button>
        </>
      ) : (
        <p className="muted">Only the room lead or owner can create checkpoints or export.</p>
      )}
      {exportResult && (
        <p data-testid="export-result">
          Exported to {exportResult.branch}.
          {exportResult.pull_request && (
            <>
              {" "}
              <a
                href={exportResult.pull_request.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="export-pull-request-link"
              >
                Pull request #{exportResult.pull_request.number}
              </a>
            </>
          )}
        </p>
      )}
    </section>
  );
}
