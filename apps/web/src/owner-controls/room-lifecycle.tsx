import type { Dispatch, FormEventHandler, SetStateAction } from "react";
import { RetentionSection } from "./retention.js";

export function RoomLifecycleSection({
  roomStatus,
  retentionDays,
  archivedAt,
  retentionDaysInput,
  setRetentionDaysInput,
  busy,
  freeze,
  resume,
  archive,
  unarchive,
  submitRetention,
}: {
  roomStatus: string;
  retentionDays: number;
  archivedAt: string | null;
  retentionDaysInput: string;
  setRetentionDaysInput: Dispatch<SetStateAction<string>>;
  busy: boolean;
  freeze: () => void;
  resume: () => void;
  archive: () => void;
  unarchive: () => void;
  submitRetention: FormEventHandler<HTMLFormElement>;
}) {
  return (
    <section aria-label="Room lifecycle">
      <h3>Room lifecycle</h3>
      <p>
        Room status: <strong data-testid="owner-room-status">{roomStatus}</strong>
      </p>
      {roomStatus === "ACTIVE" ? (
        <button data-testid="freeze-room" disabled={busy} onClick={freeze}>
          Freeze room
        </button>
      ) : roomStatus === "PAUSED" ? (
        <button data-testid="resume-room" disabled={busy} onClick={resume}>
          Resume room
        </button>
      ) : roomStatus === "ARCHIVED" ? (
        <button data-testid="unarchive-room" disabled={busy} onClick={unarchive}>
          Unarchive room
        </button>
      ) : (
        <p className="muted">Lifecycle controls are unavailable for this room status.</p>
      )}
      {(roomStatus === "ACTIVE" || roomStatus === "PAUSED") && (
        <button data-testid="archive-room" disabled={busy} onClick={archive}>
          Archive room
        </button>
      )}
      <RetentionSection
        archivedAt={roomStatus === "ARCHIVED" ? archivedAt : null}
        retentionDays={retentionDays}
        retentionDaysInput={retentionDaysInput}
        setRetentionDaysInput={setRetentionDaysInput}
        busy={busy}
        submitRetention={submitRetention}
      />
    </section>
  );
}
