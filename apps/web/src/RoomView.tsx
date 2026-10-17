import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { PresenceIntent, RoomClient, SdkEvent } from "@crossover/sdk";
import { isUnauthenticated } from "./App.js";
import {
  affectsState,
  describeEvent,
  TASK_STATUSES,
  type Participant,
  type RoomState,
  type Task,
} from "./model.js";
import { openRoom, type OpenRoom } from "./session.js";
import {
  applyIntentSnapshot,
  applyPresence,
  liveIntents,
  livePresence,
  type IntentMap,
  type PresenceMap,
} from "./presence.js";

// Monaco is large: it loads with the Files tab, not with the room.
const FilesView = lazy(() => import("./FilesView.js"));
const ChangesView = lazy(() => import("./ChangesView.js"));
const TaskReviewView = lazy(() => import("./TaskReviewView.js"));
const CheckpointExportView = lazy(() => import("./CheckpointExportView.js"));
const RoomExportView = lazy(() =>
  import("./RoomExportView.js").then((m) => ({ default: m.RoomExportView })),
);
const RoomSetupView = lazy(() =>
  import("./RoomSetupView.js").then((m) => ({ default: m.RoomSetupView })),
);
const OwnerControlsView = lazy(() =>
  import("./OwnerControlsView.js").then((m) => ({ default: m.OwnerControlsView })),
);
const CollaborationView = lazy(() => import("./CollaborationView.js"));
const MessagesView = lazy(() => import("./MessagesView.js"));
const TerminalView = lazy(() => import("./TerminalView.js"));

const FEED_LIMIT = 200;
const BACKLOG = 50;

type Tab =
  | "overview"
  | "setup"
  | "owner-controls"
  | "tasks"
  | "messages"
  | "collaboration"
  | "activity"
  | "files"
  | "terminal"
  | "changes"
  | "delivery";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "setup", label: "Setup" },
  { id: "owner-controls", label: "Owner controls" },
  { id: "tasks", label: "Tasks" },
  { id: "messages", label: "Messages" },
  { id: "collaboration", label: "Inbox, decisions & memory" },
  { id: "activity", label: "Activity" },
  { id: "files", label: "Files" },
  { id: "terminal", label: "Terminal" },
  { id: "changes", label: "Changes" },
  { id: "delivery", label: "Review & export" },
];

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";

type EvidenceKind = "test" | "check" | "manual";

interface TaskEvidenceDraft {
  kind: EvidenceKind;
  ref: string;
  note: string;
}

interface TaskEvidenceItem {
  requirement: number;
  proof: { kind: EvidenceKind; ref: string; note?: string }[];
}

interface HealthBadge {
  status: string;
  revision: number;
  sequence: number;
}

function healthBadge(event: SdkEvent): HealthBadge | undefined {
  const status = event.payload["status"];
  const revision = event.payload["revision"];
  if (
    event.type !== "workspace.health" ||
    typeof status !== "string" ||
    typeof revision !== "number"
  )
    return undefined;
  return { status, revision, sequence: event.sequence };
}

export function RoomView(props: { roomId: string; onBack: () => void; onSignedOut: () => void }) {
  const { roomId, onBack, onSignedOut } = props;
  const [open, setOpen] = useState<OpenRoom>();
  const [error, setError] = useState<string>();
  const [state, setState] = useState<RoomState>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workspaceRevision, setWorkspaceRevision] = useState<number>();
  const [workspaceHealth, setWorkspaceHealth] = useState<HealthBadge>();
  const [workspaceStatusError, setWorkspaceStatusError] = useState<string>();
  const [feed, setFeed] = useState<SdkEvent[]>([]);
  const [live, setLive] = useState<string>("connecting");
  const [tab, setTab] = useState<Tab>("overview");
  const [notice, setNotice] = useState<string>();
  const [presence, setPresence] = useState<PresenceMap>(new Map());
  const [intents, setIntents] = useState<IntentMap>(new Map());
  const [taskTitle, setTaskTitle] = useState("");
  const [taskRequirements, setTaskRequirements] = useState("");
  const [taskAssignees, setTaskAssignees] = useState<Record<string, string>>({});
  const [taskBlockReasons, setTaskBlockReasons] = useState<Record<string, string>>({});
  const [taskEvidence, setTaskEvidence] = useState<
    Record<string, Record<number, TaskEvidenceDraft>>
  >({});
  const [taskBusy, setTaskBusy] = useState<string>();
  const roomRef = useRef<RoomClient>(undefined);
  const listeners = useRef(new Set<(event: SdkEvent) => void>());
  const onEvent = useCallback((listener: (event: SdkEvent) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  // Enter the room.
  useEffect(() => {
    let cancelled = false;
    let activeRoom: RoomClient | undefined;
    openRoom(roomId).then(
      (entered) => {
        if (cancelled) {
          entered.room.close();
          return;
        }
        activeRoom = entered.room;
        roomRef.current = entered.room;
        setOpen(entered);
      },
      (err: unknown) => {
        if (isUnauthenticated(err)) onSignedOut();
        else if (!cancelled) setError(message(err));
      },
    );
    return () => {
      cancelled = true;
      activeRoom?.close();
      roomRef.current = undefined;
    };
  }, [roomId, onSignedOut]);

  const reload = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    try {
      const [s, t] = await Promise.all([
        room.api.room.get_state<RoomState>({ view: "summary" }),
        room.api.tasks.list<{ tasks: Task[] }>({ limit: 100 }),
      ]);
      setState(s.response);
      setTasks(t.response.tasks);
    } catch (err) {
      setError(message(err));
    }
  }, []);

  // Load, then follow: the last events first, every later one live.
  useEffect(() => {
    if (!open) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), 150);
    };
    let sub: ReturnType<RoomClient["subscribe"]> | undefined;
    void (async () => {
      await reload();
      if (closed || open.room.isClosed) return;
      let last = 0;
      try {
        last = (await open.room.api.room.get_state<RoomState>({ view: "summary" })).response
          .last_sequence;
      } catch {
        // the feed then starts from the beginning
      }
      if (closed || open.room.isClosed) return;
      sub = open.room.subscribe({
        after: Math.max(0, last - BACKLOG),
        onState: (s) => setLive(s),
        onEvent: (event) => {
          setFeed((f) => [event, ...f].slice(0, FEED_LIMIT));
          if (event.type === "workspace.changeset.applied") {
            const revision = event.payload["applied_revision"];
            if (typeof revision === "number")
              setWorkspaceRevision((current) => Math.max(current ?? 0, revision));
          } else if (event.type === "workspace.upstream_synced") {
            const revision = event.payload["last_synced_room_revision"];
            if (typeof revision === "number")
              setWorkspaceRevision((current) => Math.max(current ?? 0, revision));
          }
          const health = healthBadge(event);
          if (health)
            setWorkspaceHealth((current) =>
              !current || health.sequence > current.sequence ? health : current,
            );
          if (affectsState(event.type)) refreshSoon();
          for (const listener of listeners.current) listener(event);
        },
        onError: (err) => setError(message(err)),
        onPresence: (update) => setPresence((p) => applyPresence(p, update)),
        onPresenceIntents: (snapshot: PresenceIntent[]) =>
          setIntents(applyIntentSnapshot(snapshot)),
      });
    })();
    // Records and intents aren't announced when they expire: drop them at their deadline.
    const expiry = setInterval(() => {
      const now = Date.now();
      setPresence((p) => livePresence(p, now));
      setIntents((p) => liveIntents(p, now));
    }, 5_000);
    return () => {
      closed = true;
      clearTimeout(timer);
      clearInterval(expiry);
      sub?.close();
    };
  }, [open, reload]);

  // The workspace head and latest health result are durable room data, not settings.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const [history, latestHealth] = await Promise.all([
        open.room.api.workspace.history<{ entries: { workspace_revision: number }[] }>({
          limit: 1,
        }),
        (async () => {
          let after = 0;
          let latest: HealthBadge | undefined;
          for (;;) {
            const page = await open.room.api.room.events.list<{
              events: SdkEvent[];
              next_after: number | null;
            }>({ after, limit: 500, types: ["workspace.health"] });
            const last = page.response.events.at(-1);
            if (last) latest = healthBadge(last) ?? latest;
            if (page.response.next_after === null) return latest;
            after = page.response.next_after;
          }
        })(),
      ]);
      if (cancelled) return;
      const revision = history.response.entries[0]?.workspace_revision;
      if (typeof revision === "number")
        setWorkspaceRevision((current) => Math.max(current ?? 0, revision));
      if (latestHealth)
        setWorkspaceHealth((current) =>
          !current || latestHealth.sequence > current.sequence ? latestHealth : current,
        );
      setWorkspaceStatusError(undefined);
    })().catch((error: unknown) => {
      if (!cancelled) setWorkspaceStatusError(message(error));
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const names = useMemo(() => {
    const byId = new Map((state?.sections.participants ?? []).map((p) => [p.id, p.display_name]));
    return (id: string) => (id === "system" ? "System" : (byId.get(id) ?? id.slice(0, 10)));
  }, [state]);
  const purposeOf = useMemo(() => {
    const byId = new Map(tasks.map((task) => [task.id, task.title]));
    return (taskId: string) => byId.get(taskId);
  }, [tasks]);

  if (error && !state) {
    return (
      <main className="card">
        <p role="alert" className="error">
          {error}
        </p>
        <button onClick={onBack}>Back to rooms</button>
      </main>
    );
  }
  if (!open || !state) return <main className="card">Loading…</main>;

  const { room, participants } = {
    room: state.sections.room,
    participants: state.sections.participants,
  };
  const me = open.me;
  const mayControl = me.authority === "OWNER" || me.authority === "ADMIN" || me.role === "LEAD";
  const mayImport = me.authority === "OWNER" || me.role === "LEAD";
  const maySetHealth = me.authority === "OWNER" || me.role === "LEAD";
  const mayInvite = me.authority === "OWNER" || me.authority === "ADMIN";
  const mayAppointLead = me.authority === "OWNER" || me.authority === "ADMIN";
  const maySetup = mayImport || mayInvite || mayAppointLead;
  const mayCreateTasks = me.role === "DEVELOPER" || me.role === "LEAD";
  const mayClaimTasks = mayCreateTasks;
  const mayAssignTasks = me.authority === "OWNER" || me.authority === "ADMIN" || me.role === "LEAD";

  const control = async (p: Participant, method: "pause" | "resume") => {
    setNotice(undefined);
    try {
      await open.room.api.participants[method]({ participant_id: p.id });
      await reload();
    } catch (err) {
      setNotice(message(err));
    }
  };

  const createTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requirements = taskRequirements
      .split("\n")
      .map((requirement) => requirement.trim())
      .filter(Boolean);
    setTaskBusy("create");
    setNotice(undefined);
    try {
      await open.room.api.tasks.create({ title: taskTitle.trim(), requirements });
      setTaskTitle("");
      setTaskRequirements("");
      await reload();
    } catch (err) {
      setNotice(message(err));
    } finally {
      setTaskBusy(undefined);
    }
  };

  const mayManageTask = (task: Task) => mayAssignTasks || task.owner_id === me.participant_id;

  const taskAction = async (
    task: Task,
    action: "claim" | "assign" | "start" | "submit" | "block" | "unblock" | "release",
    evidence?: TaskEvidenceItem[],
    reason?: string,
  ) => {
    if (
      action === "release" &&
      !window.confirm(
        `Release “${task.title}” back to the board? Its owner and blocked reason will be cleared.`,
      )
    )
      return;
    setTaskBusy(task.id);
    setNotice(undefined);
    try {
      if (action === "claim") {
        await open.room.api.tasks.claim({ task_id: task.id, expected_version: task.version });
      } else if (action === "assign") {
        const participantId =
          taskAssignees[task.id] ??
          participants.find((participant) => participant.status === "ACTIVE")?.id;
        if (!participantId) throw new Error("Choose an active participant to assign this task.");
        await open.room.api.tasks.assign({
          task_id: task.id,
          expected_version: task.version,
          participant_id: participantId,
        });
      } else if (action === "block") {
        await open.room.api.tasks.block({
          task_id: task.id,
          expected_version: task.version,
          reason: reason ?? "",
        });
        setTaskBlockReasons((current) => ({ ...current, [task.id]: "" }));
      } else if (action === "unblock") {
        await open.room.api.tasks.unblock({ task_id: task.id, expected_version: task.version });
      } else if (action === "release") {
        await open.room.api.tasks.release({ task_id: task.id, expected_version: task.version });
      } else if (action === "start") {
        await open.room.api.tasks.start({ task_id: task.id, expected_version: task.version });
      } else {
        await open.room.api.tasks.submit({
          task_id: task.id,
          expected_version: task.version,
          evidence: evidence ?? [],
        });
        setTaskEvidence((current) => {
          const remaining = { ...current };
          delete remaining[task.id];
          return remaining;
        });
      }
      await reload();
    } catch (err) {
      const failureNotice = message(err);
      try {
        await reload();
      } finally {
        setTaskBusy(undefined);
        setNotice(failureNotice);
      }
    } finally {
      setTaskBusy(undefined);
    }
  };

  const submitTask = (event: FormEvent<HTMLFormElement>, task: Task) => {
    event.preventDefault();
    const evidence = task.requirements.flatMap((_, requirement): TaskEvidenceItem[] => {
      const draft = taskEvidence[task.id]?.[requirement];
      const ref = draft?.ref.trim();
      if (!draft || !ref) return [];
      const note = draft.note.trim();
      return [
        {
          requirement,
          proof: [{ kind: draft.kind, ref, ...(note ? { note } : {}) }],
        },
      ];
    });
    void taskAction(task, "submit", evidence);
  };

  const updateTaskEvidence = (
    taskId: string,
    requirement: number,
    update: Partial<TaskEvidenceDraft>,
  ) => {
    setTaskEvidence((current) => ({
      ...current,
      [taskId]: {
        ...current[taskId],
        [requirement]: {
          kind: "check",
          ref: "",
          note: "",
          ...current[taskId]?.[requirement],
          ...update,
        },
      },
    }));
  };

  return (
    <main className="card wide">
      <button className="link" onClick={onBack}>
        ← Rooms
      </button>
      <h1 data-testid="room-title">{room.name}</h1>
      <p className="muted">
        {room.objective} <span className="badge">{room.status}</span>{" "}
        <span className="badge" data-testid="live-state">
          {live}
        </span>
        <span className="badge" data-testid="workspace-revision">
          Revision {workspaceRevision ?? "—"}
        </span>{" "}
        <span className="badge" data-testid="workspace-health">
          Health{" "}
          {workspaceHealth ? `${workspaceHealth.status} · r${workspaceHealth.revision}` : "not run"}
        </span>
      </p>
      {workspaceStatusError && (
        <p role="alert" className="error" data-testid="workspace-status-error">
          Workspace status unavailable: {workspaceStatusError}
        </p>
      )}
      <nav className="tabs" role="tablist">
        {TABS.filter(
          ({ id }) =>
            (id !== "setup" || maySetup) && (id !== "owner-controls" || me.authority === "OWNER"),
        ).map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            data-testid={`tab-${id}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="alert" className="error" data-testid="notice">
          {notice}
        </p>
      )}
      {tab === "overview" && (
        <section aria-label="Participants">
          <h2>Participants</h2>
          <table data-testid="participants">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Role</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {participants.map((p) => (
                <tr key={p.id} data-testid="participant" data-name={p.display_name}>
                  <td>
                    {p.display_name}
                    {p.id === me.participant_id && <span className="muted"> (you)</span>}
                    {p.id === room.lead_participant_id && <span className="badge">lead</span>}
                  </td>
                  <td>{p.kind}</td>
                  <td>
                    {p.role} / {p.authority}
                  </td>
                  <td data-testid="participant-status">{p.status}</td>
                  <td>
                    {mayControl && p.id !== me.participant_id && p.status === "ACTIVE" && (
                      <button data-testid="pause" onClick={() => void control(p, "pause")}>
                        Pause
                      </button>
                    )}
                    {mayControl && p.id !== me.participant_id && p.status === "PAUSED" && (
                      <button data-testid="resume" onClick={() => void control(p, "resume")}>
                        Resume
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {tab === "tasks" && (
        <section aria-label="Tasks board">
          <h2>Tasks</h2>
          {mayCreateTasks && (
            <form onSubmit={(event) => void createTask(event)} data-testid="task-create-form">
              <label>
                Task title
                <input
                  value={taskTitle}
                  onChange={(event) => setTaskTitle(event.target.value)}
                  maxLength={200}
                  required
                  data-testid="task-title"
                />
              </label>
              <label>
                Requirements (one per line)
                <textarea
                  value={taskRequirements}
                  onChange={(event) => setTaskRequirements(event.target.value)}
                  maxLength={50_000}
                  required
                  data-testid="task-requirements"
                />
              </label>
              <button disabled={taskBusy !== undefined} data-testid="task-create">
                {taskBusy === "create" ? "Creating…" : "Create task"}
              </button>
            </form>
          )}
          <div className="board" data-testid="board">
            {TASK_STATUSES.map((status) => (
              <div key={status} className="column" data-testid={`column-${status}`}>
                <h3>{status.replace("_", " ")}</h3>
                {tasks
                  .filter((t) => t.status === status)
                  .map((t) => (
                    <div key={t.id} className="task" data-testid="task" data-id={t.id}>
                      <div>{t.title}</div>
                      <div className="muted">{t.owner_id ? names(t.owner_id) : "unassigned"}</div>
                      {t.status === "BLOCKED" && t.blocked_reason && (
                        <div className="muted" data-testid="task-blocked-reason">
                          Blocked: {t.blocked_reason}
                        </div>
                      )}
                      {t.status === "OPEN" && mayClaimTasks && (
                        <button
                          disabled={taskBusy !== undefined}
                          data-testid="task-claim"
                          onClick={() => void taskAction(t, "claim")}
                        >
                          Claim
                        </button>
                      )}
                      {t.status === "OPEN" && mayAssignTasks && (
                        <span className="task-actions">
                          <select
                            aria-label={`Assign ${t.title} to`}
                            value={
                              taskAssignees[t.id] ??
                              participants.find((participant) => participant.status === "ACTIVE")
                                ?.id ??
                              ""
                            }
                            onChange={(event) =>
                              setTaskAssignees((current) => ({
                                ...current,
                                [t.id]: event.target.value,
                              }))
                            }
                            data-testid="task-assignee"
                          >
                            {participants
                              .filter((participant) => participant.status === "ACTIVE")
                              .map((participant) => (
                                <option key={participant.id} value={participant.id}>
                                  {participant.display_name}
                                </option>
                              ))}
                          </select>
                          <button
                            disabled={
                              taskBusy !== undefined ||
                              participants.every((p) => p.status !== "ACTIVE")
                            }
                            data-testid="task-assign"
                            onClick={() => void taskAction(t, "assign")}
                          >
                            Assign
                          </button>
                        </span>
                      )}
                      {t.status === "IN_PROGRESS" && mayManageTask(t) && (
                        <form
                          className="task-actions"
                          data-testid="task-block-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const reason = taskBlockReasons[t.id]?.trim() ?? "";
                            if (!reason) {
                              setNotice("Enter a reason before blocking this task.");
                              return;
                            }
                            void taskAction(t, "block", undefined, reason);
                          }}
                        >
                          <label>
                            Block reason
                            <textarea
                              value={taskBlockReasons[t.id] ?? ""}
                              maxLength={2000}
                              required
                              disabled={taskBusy !== undefined}
                              data-testid="task-block-reason"
                              onChange={(event) =>
                                setTaskBlockReasons((current) => ({
                                  ...current,
                                  [t.id]: event.target.value,
                                }))
                              }
                            />
                          </label>
                          <button disabled={taskBusy !== undefined} data-testid="task-block">
                            {taskBusy === t.id ? "Blocking…" : "Block"}
                          </button>
                        </form>
                      )}
                      {t.status === "BLOCKED" && mayManageTask(t) && (
                        <button
                          disabled={taskBusy !== undefined}
                          data-testid="task-unblock"
                          onClick={() => void taskAction(t, "unblock")}
                        >
                          {taskBusy === t.id ? "Unblocking…" : "Unblock"}
                        </button>
                      )}
                      {(t.status === "CLAIMED" ||
                        t.status === "IN_PROGRESS" ||
                        t.status === "BLOCKED") &&
                        mayManageTask(t) && (
                          <button
                            disabled={taskBusy !== undefined}
                            data-testid="task-release"
                            onClick={() => void taskAction(t, "release")}
                          >
                            Release
                          </button>
                        )}
                      {t.status === "CLAIMED" && t.owner_id === me.participant_id && (
                        <button
                          disabled={taskBusy !== undefined}
                          data-testid="task-start"
                          onClick={() => void taskAction(t, "start")}
                        >
                          {taskBusy === t.id ? "Starting…" : "Start"}
                        </button>
                      )}
                      {t.status === "IN_PROGRESS" && t.owner_id === me.participant_id && (
                        <form
                          className="task-submit-form"
                          data-testid="task-submit-form"
                          onSubmit={(event) => submitTask(event, t)}
                        >
                          <h4>Submit for review</h4>
                          <p className="muted">
                            Add proof for each requirement if this room requires evidence.
                          </p>
                          {t.requirements.map((requirement, index) => {
                            const draft = taskEvidence[t.id]?.[index] ?? {
                              kind: "check" as const,
                              ref: "",
                              note: "",
                            };
                            return (
                              <fieldset key={index} className="task-evidence-field">
                                <legend>{requirement}</legend>
                                <label>
                                  Proof type
                                  <select
                                    data-testid={`task-evidence-kind-${index}`}
                                    value={draft.kind}
                                    disabled={taskBusy !== undefined}
                                    onChange={(event) =>
                                      updateTaskEvidence(t.id, index, {
                                        kind: event.target.value as EvidenceKind,
                                      })
                                    }
                                  >
                                    <option value="check">Check</option>
                                    <option value="test">Test</option>
                                    <option value="manual">Manual</option>
                                  </select>
                                </label>
                                <label>
                                  Reference
                                  <input
                                    data-testid={`task-evidence-ref-${index}`}
                                    value={draft.ref}
                                    maxLength={500}
                                    disabled={taskBusy !== undefined}
                                    onChange={(event) =>
                                      updateTaskEvidence(t.id, index, { ref: event.target.value })
                                    }
                                  />
                                </label>
                                <label>
                                  Note (optional)
                                  <input
                                    data-testid={`task-evidence-note-${index}`}
                                    value={draft.note}
                                    maxLength={1000}
                                    disabled={taskBusy !== undefined}
                                    onChange={(event) =>
                                      updateTaskEvidence(t.id, index, { note: event.target.value })
                                    }
                                  />
                                </label>
                              </fieldset>
                            );
                          })}
                          <button disabled={taskBusy !== undefined} data-testid="task-submit">
                            {taskBusy === t.id ? "Submitting…" : "Submit for review"}
                          </button>
                        </form>
                      )}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </section>
      )}
      {tab === "collaboration" && (
        <Suspense fallback={<p className="muted">Loading inbox, decisions and memory…</p>}>
          <CollaborationView
            room={open.room}
            selfId={me.participant_id}
            canPropose={me.role !== "OBSERVER"}
            canPosition={me.role !== "OBSERVER"}
            canDecide={me.role === "LEAD"}
            canWriteMemory={me.role !== "OBSERVER"}
            canVeto={me.authority === "OWNER" || me.authority === "ADMIN"}
            nameOf={names}
            onEvent={onEvent}
          />
        </Suspense>
      )}
      {tab === "messages" && (
        <Suspense fallback={<p className="muted">Loading messages…</p>}>
          <MessagesView
            room={open.room}
            participants={participants}
            tasks={tasks}
            selfId={me.participant_id}
            nameOf={names}
            onEvent={onEvent}
          />
        </Suspense>
      )}
      {tab === "setup" && maySetup && (
        <Suspense fallback={<p className="muted">Loading project setup…</p>}>
          <RoomSetupView
            room={open.room}
            roomId={roomId}
            participants={participants}
            leadParticipantId={room.lead_participant_id}
            mayImport={mayImport}
            mayInvite={mayInvite}
            mayAppointLead={mayAppointLead}
            maySetHealth={maySetHealth}
            settings={room.settings}
            onEvent={onEvent}
          />
        </Suspense>
      )}
      {tab === "owner-controls" && me.authority === "OWNER" && (
        <Suspense fallback={<p className="muted">Loading owner controls…</p>}>
          <OwnerControlsView
            room={open.room}
            roomName={room.name}
            participants={participants}
            selfId={me.participant_id}
            leadParticipantId={room.lead_participant_id}
            roomStatus={room.status}
            archivedAt={room.archived_at}
            retentionDays={room.retention_days}
            settings={room.settings}
            onEvent={onEvent}
            onRefresh={reload}
          />
        </Suspense>
      )}
      {tab === "files" && (
        <Suspense fallback={<p className="muted">Loading editor…</p>}>
          <FilesView
            room={open.room}
            onEvent={onEvent}
            presence={presence}
            intents={intents}
            selfId={me.participant_id}
            nameOf={names}
            purposeOf={purposeOf}
          />
        </Suspense>
      )}
      {tab === "terminal" && (
        <Suspense fallback={<p className="muted">Loading terminal…</p>}>
          <TerminalView
            room={open.room}
            selfId={me.participant_id}
            participants={participants}
            events={feed}
          />
        </Suspense>
      )}
      {tab === "changes" && (
        <Suspense fallback={<p className="muted">Loading changes…</p>}>
          <ChangesView
            room={open.room}
            participantId={me.participant_id}
            mayDecideHolds={me.authority === "OWNER" || me.role === "LEAD"}
            mayManageConflicts={me.authority === "OWNER" || me.role === "LEAD"}
            nameOf={names}
            onEvent={onEvent}
          />
        </Suspense>
      )}
      {tab === "delivery" && (
        <Suspense fallback={<p className="muted">Loading review and export…</p>}>
          <>
            <TaskReviewView
              room={open.room}
              participantId={me.participant_id}
              mayManageTasks={
                me.authority === "OWNER" || me.authority === "ADMIN" || me.role === "LEAD"
              }
              onEvent={onEvent}
            />
            <RoomExportView
              room={open.room}
              mayExportRoom={me.authority === "OWNER" || me.authority === "ADMIN"}
            />
            <CheckpointExportView
              room={open.room}
              mayManageDelivery={me.authority === "OWNER" || me.role === "LEAD"}
              nameOf={names}
              onEvent={onEvent}
            />
          </>
        </Suspense>
      )}
      {tab === "activity" && (
        <section aria-label="Activity">
          <h2>Activity</h2>
          <ol className="feed" data-testid="feed">
            {feed.map((e) => (
              <li key={e.sequence} data-type={e.type} data-testid="event">
                <span className="muted">#{e.sequence}</span> {describeEvent(e, names)}
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
