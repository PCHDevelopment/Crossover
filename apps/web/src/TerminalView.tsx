import { useEffect, useState, type FormEvent } from "react";
import type { RoomClient, SdkEvent } from "@crossover/sdk";
import { SandboxOutputBuffer } from "@crossover/sdk";
import { TerminalTextSanitizer } from "./terminal-output.js";

interface ExecutionSummary {
  execId: string;
  startedAt: number;
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
  truncated: boolean;
  bufferLimitReached: boolean;
  resyncing: boolean;
  resynced: boolean;
  error?: string;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";

const emptyOutput = (): OutputState => ({
  chunks: [],
  lastSequence: 0,
  status: "connecting",
  truncated: false,
  bufferLimitReached: false,
  resyncing: false,
  resynced: false,
});

function executionsFromEvents(events: SdkEvent[], selfId: string): ExecutionSummary[] {
  return events
    .filter(
      (event) =>
        event.type === "sandbox.exec.started" && event.payload["participant_id"] === selfId,
    )
    .flatMap((event) =>
      typeof event.payload["exec_id"] === "string"
        ? [{ execId: event.payload["exec_id"], startedAt: event.sequence }]
        : [],
    )
    .sort((a, b) => b.startedAt - a.startedAt);
}

export default function TerminalView(props: {
  room: RoomClient;
  selfId: string;
  events: SdkEvent[];
}) {
  const { room, selfId, events } = props;
  const [command, setCommand] = useState("");
  const [selectedExecId, setSelectedExecId] = useState("");
  const [output, setOutput] = useState<OutputState>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [cancelling, setCancelling] = useState(false);

  const executions = executionsFromEvents(events, selfId);

  useEffect(() => {
    if (!selectedExecId) return;
    const execId = selectedExecId;
    setOutput(emptyOutput());
    const buffer = new SandboxOutputBuffer();
    const sanitizers = {
      stdout: new TerminalTextSanitizer(),
      stderr: new TerminalTextSanitizer(),
    };
    const subscription = room.subscribeSandboxOutput(execId, {
      onState: (state) => {
        setOutput((current) => {
          const previous = current ?? emptyOutput();
          return previous.status === "finished" || previous.status === "error"
            ? previous
            : {
                ...previous,
                status: state === "closed" ? previous.status : state === "live" ? "running" : state,
                resyncing: state === "reconnecting",
                resynced: previous.resynced || (state === "live" && previous.resyncing),
              };
        });
      },
      onUpdate: (update) => {
        const buffered = buffer.push(update);
        const chunks = buffered.chunks
          .map(({ stream, text }) => ({ stream, text: sanitizers[stream].write(text) }))
          .filter((chunk) => chunk.text.length > 0);
        if (buffered.kind === "finished") {
          sanitizers.stdout.finish();
          sanitizers.stderr.finish();
        }
        setOutput((current) => ({
          ...(current ?? emptyOutput()),
          chunks: [...(current?.chunks ?? []), ...chunks],
          lastSequence: buffered.sequence,
          bufferLimitReached: buffered.bufferLimitReached,
          truncated: buffered.truncated,
          ...(buffered.kind === "finished"
            ? {
                status: "finished" as const,
                exitCode: buffered.exit_code,
                reason: buffered.reason,
              }
            : {}),
        }));
      },
      onError: (error) =>
        setOutput((current) => ({
          ...(current ?? emptyOutput()),
          status: "error",
          error: message(error),
        })),
    });
    return () => subscription.close();
  }, [room, selectedExecId]);

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
      const result = await room.api.sandbox.exec<{ exec_id: string }>({
        command: trimmed,
      });
      const execId = result.response.exec_id;
      setOutput(undefined);
      setSelectedExecId(execId);
      setCommand("");
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(false);
    }
  };

  const selectedOutput = output;
  const selectedStatus = selectedOutput?.status ?? "connecting";
  const mayCancel = Boolean(selectedExecId) && selectedStatus !== "finished";

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
        <button type="submit" disabled={busy || command.trim().length === 0}>
          {busy ? "Starting…" : "Run command"}
        </button>
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
            onChange={(event) => {
              setOutput(undefined);
              setSelectedExecId(event.target.value);
            }}
          >
            {executions.map((execution) => {
              return (
                <option key={execution.execId} value={execution.execId}>
                  {execution.execId.slice(-8)}
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
              <strong>{`Your sandbox · ${selectedExecId.slice(-8)}`}</strong>
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
    </section>
  );
}
