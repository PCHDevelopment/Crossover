import type { Dispatch, FormEventHandler, SetStateAction } from "react";

export function RetentionSection({
  archivedAt,
  retentionDays,
  retentionDaysInput,
  setRetentionDaysInput,
  busy,
  submitRetention,
}: {
  archivedAt: string | null;
  retentionDays: number;
  retentionDaysInput: string;
  setRetentionDaysInput: Dispatch<SetStateAction<string>>;
  busy: boolean;
  submitRetention: FormEventHandler<HTMLFormElement>;
}) {
  return (
    <>
      <form onSubmit={submitRetention}>
        <label>
          Retain archived room for
          <select
            data-testid="room-retention-days"
            value={retentionDaysInput}
            onChange={(event) => setRetentionDaysInput(event.target.value)}
            disabled={busy}
          >
            {[30, 60, 90, 180, 365].map((days) => (
              <option key={days} value={days}>
                {days} days
              </option>
            ))}
            {![30, 60, 90, 180, 365].includes(retentionDays) && (
              <option value={retentionDays}>{retentionDays} days (current)</option>
            )}
          </select>
        </label>
        <button
          data-testid="save-room-retention"
          disabled={busy || Number(retentionDaysInput) === retentionDays}
        >
          Save retention
        </button>
      </form>
      {archivedAt && (
        <p data-testid="room-retention-deadline">
          Scheduled deletion:{" "}
          {new Date(Date.parse(archivedAt) + retentionDays * 86_400_000).toLocaleString()}
        </p>
      )}
    </>
  );
}
