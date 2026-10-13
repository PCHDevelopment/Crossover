import { useCallback, useEffect, useMemo, useState } from "react";
import type { RoomClient, SdkEvent } from "@crossover/sdk";
import MergeView from "./MergeView.js";

const CHANGE_EVENTS = [
  "workspace.changeset.applied",
  "workspace.changeset.held",
  "workspace.changeset.hold_decided",
] as const;
const HISTORY_LIMIT = 500;

interface ChangeRecord {
  id: string;
  actorId?: string;
  status: "APPLIED" | "HELD" | "REJECTED" | "CONFLICT";
  revision?: number;
  reasons: string[];
  decision?: string;
}

interface ConflictSummary {
  id: string;
  changeset_id: string;
  submitter_id: string;
  base_revision: number;
  status: "OPEN" | "ESCALATED" | "RESOLVED" | "ABANDONED";
  attempts: number;
  files: Array<{
    path: string | null;
    kind: string;
    reason?: string;
  }>;
}

interface MergeInput {
  conflict: ConflictSummary;
  path: string;
  base: string;
  mine: string;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";
const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

function applyChangeEvent(records: Map<string, ChangeRecord>, event: SdkEvent): void {
  const payload = event.payload;
  const id = typeof payload.changeset_id === "string" ? payload.changeset_id : undefined;
  if (!id) return;
  const current = records.get(id) ?? { id, status: "HELD" as const, reasons: [] };
  if (event.type === "workspace.changeset.applied") {
    const revision = payload.applied_revision;
    const actorId = typeof payload.author_id === "string" ? payload.author_id : current.actorId;
    records.set(id, {
      ...current,
      status: "APPLIED",
      ...(actorId === undefined ? {} : { actorId }),
      ...(typeof revision === "number" ? { revision } : {}),
    });
  } else if (event.type === "workspace.changeset.held") {
    const actorId = typeof payload.actor_id === "string" ? payload.actor_id : current.actorId;
    records.set(id, {
      ...current,
      status: "HELD",
      ...(actorId === undefined ? {} : { actorId }),
      reasons: Array.isArray(payload.reasons)
        ? payload.reasons.filter((reason): reason is string => typeof reason === "string")
        : current.reasons,
    });
  } else if (event.type === "workspace.changeset.hold_decided") {
    const decision = typeof payload.decision === "string" ? payload.decision : undefined;
    const status: ChangeRecord["status"] =
      decision === "REJECT" || payload.status === "REJECTED"
        ? "REJECTED"
        : payload.status === "CONFLICT"
          ? "CONFLICT"
          : current.status;
    records.set(id, { ...current, status, ...(decision ? { decision } : {}) });
  }
}

function changesFrom(events: SdkEvent[]): ChangeRecord[] {
  const records = new Map<string, ChangeRecord>();
  for (const event of events) applyChangeEvent(records, event);
  return [...records.values()].sort((a, b) => {
    const aRevision = a.revision ?? -1;
    const bRevision = b.revision ?? -1;
    return bRevision - aRevision || b.id.localeCompare(a.id);
  });
}

export default function ChangesView(props: {
  room: RoomClient;
  participantId: string;
  mayDecideHolds: boolean;
  mayManageConflicts: boolean;
  nameOf: (id: string) => string;
  onEvent: (listener: (event: SdkEvent) => void) => () => void;
}) {
  const { room, participantId, mayDecideHolds, mayManageConflicts, nameOf, onEvent } = props;
  const [events, setEvents] = useState<SdkEvent[]>([]);
  const [conflicts, setConflicts] = useState<ConflictSummary[]>([]);
  const [selectedConflict, setSelectedConflict] = useState<ConflictSummary>();
  const [mergeInput, setMergeInput] = useState<MergeInput>();
  const [selectedChange, setSelectedChange] = useState<ChangeRecord>();
  const [diff, setDiff] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const loadChanges = useCallback(async () => {
    const found: SdkEvent[] = [];
    let after = 0;
    for (;;) {
      const page = await room.api.room.events.list<{
        events: SdkEvent[];
        next_after: number | null;
      }>({ after, limit: HISTORY_LIMIT, types: [...CHANGE_EVENTS] });
      found.push(...page.response.events);
      if (page.response.next_after === null) break;
      after = page.response.next_after;
    }
    setEvents(found);
  }, [room]);

  const loadConflicts = useCallback(async () => {
    const page = await room.api.conflicts.list<{ conflicts: ConflictSummary[] }>({
      status: ["OPEN", "ESCALATED"],
      limit: 100,
    });
    setConflicts(page.response.conflicts);
  }, [room]);

  const refresh = useCallback(async () => {
    setNotice(undefined);
    try {
      await Promise.all([loadChanges(), loadConflicts()]);
    } catch (error) {
      setNotice(message(error));
    }
  }, [loadChanges, loadConflicts]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      onEvent((event) => {
        if (CHANGE_EVENTS.includes(event.type as (typeof CHANGE_EVENTS)[number])) {
          setEvents((current) => {
            if (current.some((item) => item.sequence === event.sequence)) return current;
            return [...current, event];
          });
        }
        if (event.type.startsWith("workspace.conflict.")) void loadConflicts();
      }),
    [loadConflicts, onEvent],
  );

  const changes = useMemo(() => changesFrom(events), [events]);

  const showDiff = async (change: ChangeRecord) => {
    if (change.revision === undefined) return;
    setBusy(change.id);
    setNotice(undefined);
    setDiff(undefined);
    setSelectedChange(change);
    try {
      const metadata = await room.api.workspace.changeset.get<{
        status: string;
        applied_revision: number | null;
      }>({ changeset_id: change.id });
      if (metadata.response.status !== "APPLIED" || metadata.response.applied_revision === null) {
        throw new Error("This ChangeSet has no applied revision to compare.");
      }
      const revision = metadata.response.applied_revision;
      const result = await room.api.workspace.diff<{ diff: string }>({
        from_revision: Math.max(0, revision - 1),
        to_revision: revision,
      });
      setDiff(result.response.diff);
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  };

  const showConflict = async (conflict: ConflictSummary) => {
    setBusy(conflict.id);
    setNotice(undefined);
    try {
      const result = await room.api.conflicts.get<ConflictSummary>({ conflict_id: conflict.id });
      setSelectedConflict(result.response);
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  };

  const openMerge = async (conflict: ConflictSummary) => {
    if (conflict.files.length !== 1 || !conflict.files[0]?.path) {
      setNotice("Open a single readable text-file conflict to resolve it here.");
      return;
    }
    const file = conflict.files[0];
    const path = file.path;
    if (!path) return;
    if (file.kind !== "CONTENT" && file.kind !== "ADD_ADD") {
      setNotice("This conflict type cannot be resolved in the text merge view.");
      return;
    }
    setBusy(conflict.id);
    setNotice(undefined);
    try {
      const candidate = await room.api.workspace.changeset.get<{
        content?: string;
        encoding?: string;
        deleted?: boolean;
      }>({ changeset_id: conflict.changeset_id, path });
      if (
        candidate.response.deleted ||
        candidate.response.encoding !== "utf8" ||
        typeof candidate.response.content !== "string"
      ) {
        throw new Error("This file cannot be opened in the text merge view.");
      }
      let base = "";
      try {
        const read = await room.api.workspace.read<{ content: string; encoding: string }>({
          path,
          revision: conflict.base_revision,
        });
        if (read.response.encoding !== "utf8")
          throw new Error("This file cannot be opened in the text merge view.");
        base = read.response.content;
      } catch (error) {
        if (errorCode(error) !== "NOT_FOUND") throw error;
      }
      setMergeInput({ conflict, path, base, mine: candidate.response.content });
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  };

  const conflictAction = async (conflict: ConflictSummary, action: "escalate" | "abandon") => {
    setBusy(conflict.id);
    setNotice(undefined);
    try {
      await room.api.conflicts[action]({ conflict_id: conflict.id });
      await loadConflicts();
      setSelectedConflict(undefined);
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  };

  const decideHold = async (change: ChangeRecord, decision: "APPROVE" | "REJECT") => {
    setBusy(change.id);
    setNotice(undefined);
    try {
      await room.api.workspace.changeset.decide_hold({
        changeset_id: change.id,
        decision,
      });
      await refresh();
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section aria-label="Changes and conflicts" data-testid="changes-view">
      <h2>Changes</h2>
      {notice && (
        <p role="alert" className="error" data-testid="changes-notice">
          {notice}
        </p>
      )}
      <ul className="list change-list" data-testid="changes-list">
        {changes.map((change) => (
          <li key={change.id} data-testid="change" data-id={change.id} data-status={change.status}>
            <strong>
              {change.status === "APPLIED" ? `Revision ${change.revision}` : change.status}
            </strong>
            <span className="muted">
              {" "}
              · {nameOf(change.actorId ?? "system")} · {change.id}
            </span>
            {change.reasons.length > 0 && <p>Held for: {change.reasons.join(", ")}</p>}
            {change.status === "APPLIED" && (
              <button disabled={busy === change.id} onClick={() => void showDiff(change)}>
                View diff
              </button>
            )}
            {change.status === "HELD" && mayDecideHolds && (
              <span className="change-actions">
                <button
                  disabled={busy === change.id}
                  onClick={() => void decideHold(change, "APPROVE")}
                >
                  Approve
                </button>
                <button
                  disabled={busy === change.id}
                  onClick={() => void decideHold(change, "REJECT")}
                >
                  Reject
                </button>
              </span>
            )}
          </li>
        ))}
        {changes.length === 0 && <li className="muted">No applied or held ChangeSets yet.</li>}
      </ul>
      {selectedChange && (
        <section className="change-detail" aria-label="ChangeSet diff">
          <h3>Revision {selectedChange.revision} diff</h3>
          {busy === selectedChange.id ? (
            <p className="muted">Loading diff…</p>
          ) : (
            <pre data-testid="changes-diff">{diff || "No readable file changes."}</pre>
          )}
        </section>
      )}

      <h2>Conflicts</h2>
      <ul className="list change-list" data-testid="conflicts-list">
        {conflicts.map((conflict) => (
          <li
            key={conflict.id}
            data-testid="conflict"
            data-id={conflict.id}
            data-status={conflict.status}
          >
            <strong>{conflict.status}</strong>
            <span className="muted">
              {" "}
              · {conflict.id} · {conflict.attempts} attempts
            </span>
            <span className="change-actions">
              <button disabled={busy === conflict.id} onClick={() => void showConflict(conflict)}>
                Details
              </button>
              {conflict.status === "OPEN" && conflict.submitter_id === participantId && (
                <button
                  disabled={busy === conflict.id}
                  onClick={() => void conflictAction(conflict, "escalate")}
                >
                  Escalate
                </button>
              )}
              {(mayManageConflicts || conflict.submitter_id === participantId) && (
                <button
                  disabled={busy === conflict.id}
                  onClick={() => void conflictAction(conflict, "abandon")}
                >
                  Abandon
                </button>
              )}
            </span>
          </li>
        ))}
        {conflicts.length === 0 && <li className="muted">No open or escalated conflicts.</li>}
      </ul>
      {selectedConflict && (
        <section className="change-detail" aria-label="Conflict details">
          <h3>Conflict {selectedConflict.id}</h3>
          <p className="muted">Submitted ChangeSet: {selectedConflict.changeset_id}</p>
          {selectedConflict.files.map((file, index) => (
            <p key={`${file.path ?? "hidden"}-${index}`}>
              {file.path ?? "Restricted file"} <span className="badge">{file.kind}</span>
            </p>
          ))}
          {mayManageConflicts &&
            selectedConflict.status === "ESCALATED" &&
            selectedConflict.files.length === 1 &&
            selectedConflict.files[0]?.path && (
              <button
                disabled={busy === selectedConflict.id}
                onClick={() => void openMerge(selectedConflict)}
              >
                Resolve in MergeView
              </button>
            )}
        </section>
      )}
      {mergeInput && (
        <MergeView
          key={mergeInput.conflict.id}
          room={room}
          path={mergeInput.path}
          conflictId={mergeInput.conflict.id}
          base={mergeInput.base}
          mine={mergeInput.mine}
          onResolved={() => {
            setMergeInput(undefined);
            setSelectedConflict(undefined);
            void refresh();
          }}
          onDiscarded={() => {
            setMergeInput(undefined);
            setSelectedConflict(undefined);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
