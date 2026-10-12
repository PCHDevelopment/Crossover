import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const RoomSetupView = lazy(() =>
  import("./RoomSetupView.js").then((m) => ({ default: m.RoomSetupView })),
);
const OwnerControlsView = lazy(() =>
  import("./OwnerControlsView.js").then((m) => ({ default: m.OwnerControlsView })),
);

const FEED_LIMIT = 200;
const BACKLOG = 50;

type Tab =
  "overview" | "setup" | "owner-controls" | "tasks" | "activity" | "files" | "changes" | "delivery";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "setup", label: "Setup" },
  { id: "owner-controls", label: "Owner controls" },
  { id: "tasks", label: "Tasks" },
  { id: "activity", label: "Activity" },
  { id: "files", label: "Files" },
  { id: "changes", label: "Changes" },
  { id: "delivery", label: "Review & export" },
];

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";

export function RoomView(props: {
  session: string;
  roomId: string;
  onBack: () => void;
  onSignedOut: () => void;
}) {
  const { session, roomId, onBack, onSignedOut } = props;
  const [open, setOpen] = useState<OpenRoom>();
  const [error, setError] = useState<string>();
  const [state, setState] = useState<RoomState>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [feed, setFeed] = useState<SdkEvent[]>([]);
  const [live, setLive] = useState<string>("connecting");
  const [tab, setTab] = useState<Tab>("overview");
  const [notice, setNotice] = useState<string>();
  const [presence, setPresence] = useState<PresenceMap>(new Map());
  const [intents, setIntents] = useState<IntentMap>(new Map());
  const roomRef = useRef<RoomClient>(undefined);
  const listeners = useRef(new Set<(event: SdkEvent) => void>());
  const onEvent = useCallback((listener: (event: SdkEvent) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  // Enter the room.
  useEffect(() => {
    let cancelled = false;
    openRoom(session, roomId).then(
      (entered) => {
        if (cancelled) return;
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
    };
  }, [session, roomId, onSignedOut]);

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
      if (closed) return;
      let last = 0;
      try {
        last = (await open.room.api.room.get_state<RoomState>({ view: "summary" })).response
          .last_sequence;
      } catch {
        // the feed then starts from the beginning
      }
      if (closed) return;
      sub = open.room.subscribe({
        after: Math.max(0, last - BACKLOG),
        onState: (s) => setLive(s),
        onEvent: (event) => {
          setFeed((f) => [event, ...f].slice(0, FEED_LIMIT));
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
  const mayInvite = me.authority === "OWNER" || me.authority === "ADMIN";
  const mayAppointLead = me.authority === "OWNER" || me.authority === "ADMIN";
  const maySetup = mayImport || mayInvite || mayAppointLead;

  const control = async (p: Participant, method: "pause" | "resume") => {
    setNotice(undefined);
    try {
      await open.room.api.participants[method]({ participant_id: p.id });
      await reload();
    } catch (err) {
      setNotice(message(err));
    }
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
      </p>
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
          <div className="board" data-testid="board">
            {TASK_STATUSES.map((status) => (
              <div key={status} className="column" data-testid={`column-${status}`}>
                <h3>{status.replace("_", " ")}</h3>
                {tasks
                  .filter((t) => t.status === status)
                  .map((t) => (
                    <div key={t.id} className="task" data-testid="task">
                      <div>{t.title}</div>
                      <div className="muted">{t.owner_id ? names(t.owner_id) : "unassigned"}</div>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </section>
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
