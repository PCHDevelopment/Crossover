import { useCallback, useEffect, useState } from "react";
import { CrossoverError, type UserRoomInfo } from "@crossover/sdk";
import { client } from "./session.js";
import { RoomView } from "./RoomView.js";

/** `/` the room list, `/rooms/<id>` one room. */
const roomIdOf = (path: string): string | undefined => /^\/rooms\/([^/]+)\/?$/.exec(path)?.[1];

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean>();
  const [providers, setProviders] = useState<string[]>([]);
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    let active = true;
    void client.authProviders().then(
      (names) => active && setProviders(names),
      (err: unknown) => active && setBootstrapError(message(err)),
    );
    void client.authSession().then(
      (isAuthenticated) => active && setAuthenticated(isAuthenticated),
      (err: unknown) => {
        if (!active) return;
        setBootstrapError(message(err));
        setAuthenticated(false);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((to: string) => {
    window.history.pushState({}, "", to);
    setPath(to);
  }, []);
  const signIn = () => {
    setBootstrapError(undefined);
    setAuthenticated(true);
    go("/");
  };
  const signedOut = useCallback(() => {
    client.clearRoomSessions();
    setAuthenticated(false);
    go("/");
  }, [go]);
  const signOut = async () => {
    client.clearRoomSessions();
    try {
      await client.logout();
    } catch (err) {
      setBootstrapError(message(err));
    }
    signedOut();
  };

  if (authenticated === undefined) return <main className="card">Loading…</main>;
  if (!authenticated)
    return <Login providers={providers} error={bootstrapError} onSession={signIn} />;
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
        <button data-testid="sign-out" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      {roomId ? (
        <RoomView key={roomId} roomId={roomId} onBack={() => go("/")} onSignedOut={signedOut} />
      ) : (
        <Rooms onOpen={(id) => go(`/rooms/${id}`)} onSignedOut={signedOut} />
      )}
    </div>
  );
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";
export const isUnauthenticated = (error: unknown): boolean =>
  error instanceof CrossoverError && error.code === "UNAUTHENTICATED";

function Login({
  providers,
  error: bootstrapError,
  onSession,
}: {
  providers: string[];
  error?: string | undefined;
  onSession: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <main className="card narrow">
      <h1>Crossover</h1>
      <p>Sign in to your rooms.</p>
      {providers.map((provider) => (
        <p key={provider}>
          <a
            data-testid={`oauth-${provider}`}
            href={`/v1/auth/oauth/${encodeURIComponent(provider)}`}
          >
            Continue with{" "}
            {provider === "github" ? "GitHub" : provider === "google" ? "Google" : provider}
          </a>
        </p>
      ))}
      {bootstrapError && (
        <p role="alert" className="error">
          {bootstrapError}
        </p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            // Development sign-in: the server accepts it only when it is switched on.
            await client.devLogin({
              subject: name.trim(),
              display_name: name.trim(),
            });
            onSession();
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

function Rooms({ onOpen, onSignedOut }: { onOpen: (id: string) => void; onSignedOut: () => void }) {
  const [rooms, setRooms] = useState<UserRoomInfo[]>();
  const [error, setError] = useState<string>();
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRooms(await client.rooms());
    } catch (err) {
      if (isUnauthenticated(err)) onSignedOut();
      else setError(message(err));
    }
  }, [onSignedOut]);
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
            const created = await client.createRoom(undefined, {
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
