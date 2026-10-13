import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  RoomClient,
  SandboxOutputSubscription,
  SandboxOutputUpdate,
  SdkEvent,
} from "@crossover/sdk";
import type { Participant } from "./model.js";
import AgentOutputView from "./AgentOutputView.js";
import { sanitizeTerminalText } from "./terminal-output.js";

const MAX_DISPLAY_BYTES = 1024 * 1024;

interface ExecutionResponse {
  exec_id: string;
  timeout_s: number;
}

interface ExecutionSummary {
  execId: string;
  startedAt: number;
  finished: boolean;
  exitCode?: number | null;
}

interface OutputChunk {
  stream: "stdout" | "stderr";
  text: string;
}

interface OutputState {
  chunks: OutputChunk[];
  lastSequence: number;
  status: "connecting" | "running" | "reconnecting" | "finished" | "error";
  exitCode?: number | null;
  reason?: string | null;
  durationMs?: number | null;
  truncated: boolean;
  bufferLimitReached: boolean;
  outputBytes: number;
  resyncing: boolean;
  resynced: boolean;
  error?: string;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";

function summariesFromEvents(events: SdkEvent[], selfId: string): ExecutionSummary[] {
  const summaries = new Map<string, ExecutionSummary>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const execId = event.payload["exec_id"];
    const participantId = event.payload["participant_id"];
    if (typeof execId !== "string" || participantId !== selfId) continue;
    const previous = summaries.get(execId);
    if (event.type === "sandbox.exec.started") {
      summaries.set(execId, {
        execId,
        startedAt: event.sequence,
        finished: previous?.finished ?? false,
        ...(previous?.exitCode === undefined ? {} : { exitCode: previous.exitCode }),
      });
    } else if (event.type === "sandbox.exec.finished") {
      summaries.set(execId, {
        execId,
        startedAt: previous?.startedAt ?? event.sequence,
        finished: true,
        exitCode:
          typeof event.payload["exit_code"] === "number" || event.payload["exit_code"] === null
            ? event.payload["exit_code"]
            : null,
      });
    }
  }
  return [...summaries.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export default function TerminalView(props: {
  room: RoomClient;
  selfId: string;
  participants: Participant[];
  events: SdkEvent[];
}) {
  const { room, selfId, participants, events } = props;
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [selectedExecId, setSelectedExecId] = useState("");
  const [launched, setLaunched] = useState<Record<string, string>>({});
  const [outputs, setOutputs] = useState<Record<string, OutputState>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [cancelling, setCancelling] = useState(false);
  const subscriptions = useRef(new Map<string, SandboxOutputSubscription>());
  const browserOutputBytes = useRef(new Map<string, number>());
  const outputsRef = useRef(outputs);

  useEffect(() => {
    outputsRef.current = outputs;
  }, [outputs]);

  const executions = useMemo(() => {
    const merged = new Map(summariesFromEvents(events, selfId).map((item) => [item.execId, item]));
    for (const execId of Object.keys(launched)) {
      const previous = merged.get(execId);
      merged.set(execId, {
        execId,
        startedAt: previous?.startedAt ?? Number.MAX_SAFE_INTEGER,
        finished: previous?.finished ?? outputs[execId]?.status === "finished",
        ...(previous?.exitCode !== undefined
          ? { exitCode: previous.exitCode }
          : outputs[execId]?.exitCode !== undefined
            ? { exitCode: outputs[execId].exitCode }
            : {}),
      });
    }
    return [...merged.values()].sort((a, b) => b.startedAt - a.startedAt);
  }, [events, launched, outputs, selfId]);

  const updateOutput = useCallback(
    (execId: string, update: (previous: OutputState) => OutputState) => {
      setOutputs((current) => ({
        ...current,
        [execId]: update(
          current[execId] ?? {
            chunks: [],
            lastSequence: 0,
            status: "connecting",
            truncated: false,
            bufferLimitReached: false,
            outputBytes: 0,
            resyncing: false,
            resynced: false,
          },
        ),
      }));
    },
    [],
  );

  useEffect(() => {
    if (!selectedExecId) return;
    const execId = selectedExecId;
    const lastSequence = outputsRef.current[execId]?.lastSequence ?? 0;
    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const subscription = room.subscribeSandboxOutput(execId, {
      after: lastSequence,
      onState: (state) => {
        updateOutput(execId, (previous) =>
          previous.status === "finished" || previous.status === "error"
            ? previous
            : {
                ...previous,
                status: state === "closed" ? previous.status : state === "live" ? "running" : state,
                resyncing: state === "reconnecting",
                resynced: previous.resynced || (state === "live" && previous.resyncing),
              },
        );
      },
      onUpdate: (update: SandboxOutputUpdate) => {
        if (update.kind === "data") {
          const previousBytes =
            browserOutputBytes.current.get(execId) ?? outputsRef.current[execId]?.outputBytes ?? 0;
          const acceptedBytes = Math.min(
            update.data.byteLength,
            Math.max(0, MAX_DISPLAY_BYTES - previousBytes),
          );
          browserOutputBytes.current.set(execId, previousBytes + acceptedBytes);
          const text = sanitizeTerminalText(
            decoders[update.stream].decode(update.data.subarray(0, acceptedBytes), {
              stream: true,
            }),
          );
          updateOutput(execId, (previous) => ({
            ...previous,
            chunks: text ? [...previous.chunks, { stream: update.stream, text }] : previous.chunks,
            lastSequence: update.sequence,
            outputBytes: previousBytes + acceptedBytes,
            bufferLimitReached:
              previous.bufferLimitReached || acceptedBytes < update.data.byteLength,
            truncated: previous.truncated || acceptedBytes < update.data.byteLength,
          }));
        } else if (update.kind === "truncated") {
          updateOutput(execId, (previous) => ({
            ...previous,
            lastSequence: update.sequence,
            truncated: true,
          }));
        } else {
          const trailing = (Object.keys(decoders) as (keyof typeof decoders)[])
            .map((stream) => ({
              stream,
              text: sanitizeTerminalText(decoders[stream].decode()),
            }))
            .filter((chunk) => chunk.text.length > 0);
          updateOutput(execId, (previous) => ({
            ...previous,
            chunks: [...previous.chunks, ...trailing],
            status: "finished",
            exitCode: update.exit_code,
            reason: update.reason,
            durationMs: update.duration_ms,
            truncated: previous.truncated || update.truncated,
          }));
        }
      },
      onError: (error) =>
        updateOutput(execId, (previous) => ({
          ...previous,
          status: "error",
          error: message(error),
        })),
    });
    subscriptions.current.set(execId, subscription);
    return () => {
      subscription.close();
      if (subscriptions.current.get(execId) === subscription) subscriptions.current.delete(execId);
    };
  }, [room, selectedExecId, updateOutput]);

  useEffect(
    () => () => {
      for (const subscription of subscriptions.current.values()) subscription.close();
      subscriptions.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!selectedExecId && executions.length > 0) setSelectedExecId(executions[0]!.execId);
  }, [executions, selectedExecId]);

  const run = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = command.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await room.api.sandbox.exec<ExecutionResponse>({
        command: trimmed,
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      });
      const execId = result.response.exec_id;
      setLaunched((current) => ({
        ...current,
        [execId]: trimmed,
      }));
      browserOutputBytes.current.set(execId, 0);
      setOutputs((current) => ({
        ...current,
        [execId]: {
          chunks: [],
          lastSequence: 0,
          status: "connecting",
          truncated: false,
          bufferLimitReached: false,
          outputBytes: 0,
          resyncing: false,
          resynced: false,
        },
      }));
      setSelectedExecId(execId);
      setCommand("");
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(false);
    }
  };

  const selected = executions.find((item) => item.execId === selectedExecId);
  const selectedOutput = selectedExecId ? outputs[selectedExecId] : undefined;
  const selectedStatus = selectedOutput?.status ?? (selected?.finished ? "finished" : "connecting");
  const mayCancel = Boolean(selected) && selectedStatus !== "finished";

  const cancel = async () => {
    if (!selectedExecId || !mayCancel || cancelling) return;
    setCancelling(true);
    setNotice(undefined);
    try {
      await room.api.sandbox.exec.cancel({ exec_id: selectedExecId });
    } catch (error) {
      setNotice(message(error));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <section aria-label="Terminal">
      <h2>Terminal</h2>
      <p className="muted">Each command runs as a separate process in your sandbox.</p>
      <form className="terminal-command" onSubmit={(event) => void run(event)}>
        <label>
          Command
          <textarea
            aria-label="Command"
            data-testid="terminal-command"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="pnpm test"
            rows={3}
          />
        </label>
        <div className="terminal-command-actions">
          <label>
            Working directory
            <input
              aria-label="Working directory"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              placeholder="/workspace"
            />
          </label>
          <button type="submit" disabled={busy || command.trim().length === 0}>
            {busy ? "Starting…" : "Run command"}
          </button>
        </div>
      </form>
      {notice && (
        <p role="alert" className="error" data-testid="terminal-notice">
          {notice}
        </p>
      )}
      {executions.length > 0 ? (
        <label>
          Recent executions
          <select
            aria-label="Recent executions"
            value={selectedExecId}
            onChange={(event) => setSelectedExecId(event.target.value)}
          >
            {executions.map((execution) => {
              const localCommand = launched[execution.execId];
              const label = localCommand ?? execution.execId.slice(0, 13);
              return (
                <option key={execution.execId} value={execution.execId}>
                  {label}
                </option>
              );
            })}
          </select>
        </label>
      ) : (
        <p className="muted">No recent executions in this room.</p>
      )}
      {selectedExecId && (
        <div className="terminal-output-panel" data-testid="terminal-output-panel">
          <div className="terminal-output-header">
            <div>
              <strong>{launched[selectedExecId] ?? "Your sandbox"}</strong>
              <span className="muted" data-testid="terminal-status">
                {` · ${selectedStatus}`}
              </span>
              {selectedOutput?.status === "finished" && (
                <span className="muted" data-testid="terminal-result">
                  {selectedOutput.exitCode === null
                    ? ` · ${selectedOutput.reason ?? "stopped"}`
                    : ` · exit ${selectedOutput.exitCode}`}
                  {selectedOutput.reason && selectedOutput.exitCode !== null
                    ? ` · ${selectedOutput.reason}`
                    : ""}
                  {selectedOutput.durationMs === null || selectedOutput.durationMs === undefined
                    ? ""
                    : ` · ${selectedOutput.durationMs} ms`}
                </span>
              )}
            </div>
            {mayCancel && (
              <button
                type="button"
                data-testid="terminal-stop"
                onClick={() => void cancel()}
                disabled={cancelling}
              >
                {cancelling ? "Stopping…" : "Stop"}
              </button>
            )}
          </div>
          {selectedOutput?.error && (
            <p className="error" role="alert">
              Output unavailable: {selectedOutput.error}
            </p>
          )}
          {selectedOutput?.resyncing && (
            <p className="terminal-replay" role="status">
              Output connection interrupted; replaying from sequence {selectedOutput.lastSequence}.
            </p>
          )}
          {selectedOutput?.resynced && !selectedOutput.resyncing && (
            <p className="terminal-replay" role="status">
              Output resumed and replayed from the last received sequence.
            </p>
          )}
          <div className="terminal-output" aria-live="polite" data-testid="terminal-output">
            {selectedOutput?.chunks.map((chunk, index) => (
              <div className={`terminal-chunk ${chunk.stream}`} key={`${index}-${chunk.stream}`}>
                <span aria-hidden="true">{chunk.stream === "stderr" ? "err" : "out"}</span>
                <pre>{chunk.text}</pre>
              </div>
            ))}
            {selectedOutput?.bufferLimitReached && (
              <p className="terminal-truncated" role="status">
                Browser display capped at 1 MiB; additional output is not retained on this page.
              </p>
            )}
            {selectedOutput?.truncated && !selectedOutput.bufferLimitReached && (
              <p className="terminal-truncated" role="status">
                The server truncated output after reaching its execution limit.
              </p>
            )}
            {!selectedOutput?.chunks.length && !selectedOutput?.error && (
              <span className="muted">Waiting for output…</span>
            )}
          </div>
        </div>
      )}
      <AgentOutputView room={room} participants={participants} events={events} />
    </section>
  );
}
