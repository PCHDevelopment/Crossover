import { useEffect, useState, type FormEvent } from "react";
import type { RoomClient } from "@crossover/sdk";
import type { Participant } from "./model.js";

type Settings = Record<string, unknown> | null;
const DEFAULT_PROTECTED_PATHS = [".github/workflows/**", "**/*.pem", "**/.env*", "infra/prod/**"];
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const lines = (value: string): string[] => [
  ...new Set(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  ),
];
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "The action failed";

export function OwnerControlsView(props: {
  room: RoomClient;
  roomName: string;
  participants: Participant[];
  selfId: string;
  leadParticipantId: string | null;
  roomStatus: string;
  settings: Settings;
  onRefresh: () => Promise<void>;
}) {
  const {
    room,
    roomName,
    participants,
    selfId,
    leadParticipantId,
    roomStatus,
    settings,
    onRefresh,
  } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [egress, setEgress] = useState(() => list(settings?.["egress_allowlist"]).join("\n"));
  const [protectedPaths, setProtectedPaths] = useState(() =>
    list(settings?.["protected_paths"] ?? DEFAULT_PROTECTED_PATHS).join("\n"),
  );

  useEffect(() => {
    setEgress(list(settings?.["egress_allowlist"]).join("\n"));
    setProtectedPaths(list(settings?.["protected_paths"] ?? DEFAULT_PROTECTED_PATHS).join("\n"));
  }, [settings]);

  const perform = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await onRefresh();
      setNotice(`${label} complete.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (participant: Participant) => {
    if (
      participant.id === selfId ||
      participant.id === leadParticipantId ||
      !window.confirm(
        `Remove ${participant.display_name}? Their room access tokens will be revoked permanently.`,
      )
    )
      return;
    void perform(`Remove ${participant.display_name}`, async () => {
      await room.api.participants.remove({ participant_id: participant.id });
    });
  };

  const submitEgress = (event: FormEvent) => {
    event.preventDefault();
    const hosts = lines(egress);
    if (
      !window.confirm(
        `Replace ${roomName}’s extra egress host allowlist with ${hosts.length ? hosts.join(", ") : "no extra hosts"}?`,
      )
    )
      return;
    void perform("Save egress allowlist", async () => {
      await room.api.room.set_egress_allowlist({ hosts });
    });
  };

  const submitProtectedPaths = (event: FormEvent) => {
    event.preventDefault();
    const patterns = lines(protectedPaths);
    if (
      !window.confirm(
        `Replace ${roomName}’s protected path patterns with ${patterns.length ? patterns.join(", ") : "no protected paths"}?`,
      )
    )
      return;
    void perform("Save protected paths", async () => {
      await room.api.room.set_protected_paths({ patterns });
    });
  };

  const freeze = () => {
    if (!window.confirm(`Freeze ${roomName}? Active agent work will stop until it is resumed.`))
      return;
    void perform("Freeze room", async () => {
      await room.api.room.freeze({});
    });
  };

  const resume = () =>
    void perform("Resume room", async () => {
      await room.api.room.resume({});
    });

  return (
    <section aria-label="Owner controls" data-testid="owner-controls">
      <h2>Owner controls</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" data-testid="owner-controls-notice">
          {notice}
        </p>
      )}

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
        ) : (
          <p className="muted">Lifecycle controls are unavailable for this room status.</p>
        )}
      </section>

      <section aria-label="Participant access">
        <h3>Remove participant</h3>
        <ul className="list">
          {participants
            .filter((participant) => participant.id !== selfId)
            .map((participant) => (
              <li key={participant.id} data-testid="owner-participant">
                {participant.display_name}{" "}
                <span className="muted">
                  ({participant.role}, {participant.status})
                </span>{" "}
                {participant.id === leadParticipantId ? (
                  <span className="muted">Appoint another lead before removal.</span>
                ) : (
                  <button
                    data-testid="remove-participant"
                    disabled={busy}
                    onClick={() => remove(participant)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
        </ul>
      </section>

      <section aria-label="Network egress policy">
        <h3>Extra egress hosts</h3>
        <p className="muted">
          One exact host or *.suffix pattern per line. Platform defaults remain in effect.
        </p>
        <form onSubmit={submitEgress}>
          <label>
            Allowed hosts
            <textarea
              data-testid="egress-hosts"
              rows={4}
              value={egress}
              onChange={(event) => setEgress(event.target.value)}
            />
          </label>
          <button data-testid="save-egress" disabled={busy}>
            Save egress allowlist
          </button>
        </form>
      </section>

      <section aria-label="Protected paths">
        <h3>Protected paths</h3>
        <p className="muted">
          Default patterns apply until changed. An explicit empty list disables protected-path
          checks.
        </p>
        <form onSubmit={submitProtectedPaths}>
          <label>
            Path patterns
            <textarea
              data-testid="protected-paths"
              rows={4}
              value={protectedPaths}
              onChange={(event) => setProtectedPaths(event.target.value)}
            />
          </label>
          <button data-testid="save-protected-paths" disabled={busy}>
            Save protected paths
          </button>
        </form>
      </section>
    </section>
  );
}
