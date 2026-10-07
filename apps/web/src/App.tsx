import { useCallback, useEffect, useState } from "react";
import { CrossoverError, type UserRoomInfo } from "@crossover/sdk";
import { client, getSession, setSession } from "./session.js";
import { RoomView } from "./RoomView.js";

/** `/` the room list, `/rooms/<id>` one room. */
const roomIdOf = (path: string): string | undefined => /^\/rooms\/([^/]+)\/?$/.exec(path)?.[1];

export function App() {
  const [session, setSessionState] = useState<string | undefined>(getSession());
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((to: string) => {
    window.history.pushState({}, "", to);
    setPath(to);
  }, []);
  const signIn = (token: string | undefined) => {
    setSession(token);
    setSessionState(token);
    if (!token) go("/");
  };

  if (!session) return <Login onSession={signIn} />;
  const roomId = roomIdOf(path);
  return (
    <div className="app">
      <header className="bar">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            go("/");
          }}
        >
          <strong>Crossover</strong>
        </a>
        <button data-testid="sign-out" onClick={() => signIn(undefined)}>
          Sign out
        </button>
      </header>
      {roomId ? (
        <RoomView
          key={roomId}
          session={session}
          roomId={roomId}
          onBack={() => go("/")}
          onSignedOut={() => signIn(undefined)}
        />
      ) : (
        <Rooms
          session={session}
          onOpen={(id) => go(`/rooms/${id}`)}
          onSignedOut={() => signIn(undefined)}
        />
      )}
    </div>
  );
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";
export const isUnauthenticated = (error: unknown): boolean =>
  error instanceof CrossoverError && error.code === "UNAUTHENTICATED";

function Login({ onSession }: { onSession: (token: string) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <main className="card narrow">
      <h1>Crossover</h1>
      <p>Sign in to your rooms.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            // Development sign-in: the server accepts it only when it is switched on.
            const login = await client.devLogin({
              subject: name.trim(),
              display_name: name.trim(),
            });
            onSession(login.session_token);
          } catch (err) {
            setError(message(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Your name
          <input
            data-testid="login-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            required
            autoFocus
          />
        </label>
        <button data-testid="login-submit" disabled={busy || name.trim() === ""}>
          Sign in
        </button>
      </form>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </main>
  );
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

function Rooms({
  session,
  onOpen,
  onSignedOut,
}: {
  session: string;
  onOpen: (id: string) => void;
  onSignedOut: () => void;
}) {
  const [rooms, setRooms] = useState<UserRoomInfo[]>();
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRooms(await client.rooms(session));
    } catch (err) {
      if (isUnauthenticated(err)) onSignedOut();
      else setError(message(err));
    }
  }, [session, onSignedOut]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="card">
      <h1>Rooms</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ul data-testid="room-list" className="list">
        {rooms?.map((r) => (
          <li key={r.id}>
            <button className="link" data-testid="open-room" onClick={() => onOpen(r.id)}>
              {r.name}
            </button>
            <span className="muted"> — {r.objective}</span>
            <span className="badge">{r.status}</span>
          </li>
        ))}
        {rooms?.length === 0 && <li className="muted">No rooms yet. Create one below.</li>}
      </ul>
      <h2>Create a room</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            const slug = `${slugOf(name) || "room"}-${Math.random().toString(36).slice(2, 6)}`;
            const created = await client.createRoom(session, {
              slug,
              name: name.trim(),
              objective: objective.trim(),
            });
            onOpen(created.response.room.id);
          } catch (err) {
            if (isUnauthenticated(err)) onSignedOut();
            else setError(message(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Name
          <input
            data-testid="room-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
            required
          />
        </label>
        <label>
          Objective
          <input
            data-testid="room-objective"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            maxLength={500}
            required
          />
        </label>
        <button data-testid="room-create" disabled={busy}>
          Create room
        </button>
      </form>
    </main>
  );
}
