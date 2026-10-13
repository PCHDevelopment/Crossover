import { useState } from "react";
import type { RoomClient } from "@crossover/sdk";

export function RoomExportView(props: { room: RoomClient; mayExportRoom: boolean }) {
  const { room, mayExportRoom } = props;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const download = async () => {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      const response = await room.exportArchive();
      const blob = await response.blob();
      const name = /filename="([^"]+)"/i.exec(
        response.headers.get("content-disposition") ?? "",
      )?.[1];
      const anchor = document.createElement("a");
      const url = URL.createObjectURL(blob);
      anchor.href = url;
      anchor.download = (name ?? `${room.roomId}-export.tar.gz`).replace(/[^a-zA-Z0-9._-]/g, "_");
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setNotice("Room export downloaded.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Room export failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="delivery-section" aria-label="Room export">
      <h2>Room export</h2>
      {error && (
        <p role="alert" className="error" data-testid="room-export-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" data-testid="room-export-notice">
          {notice}
        </p>
      )}
      {mayExportRoom ? (
        <button data-testid="export-room" disabled={busy} onClick={() => void download()}>
          {busy ? "Preparing room export…" : "Download room export"}
        </button>
      ) : (
        <p className="muted">Only room owners and admins can export a room.</p>
      )}
    </section>
  );
}
