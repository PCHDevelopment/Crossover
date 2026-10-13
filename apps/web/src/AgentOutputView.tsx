import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RoomClient,
  SandboxOutputSubscription,
  SandboxOutputUpdate,
  SdkEvent,
} from "@crossover/sdk";
import type { Participant } from "./model.js";
import { sanitizeTerminalText } from "./terminal-output.js";

const MAX_DISPLAY_BYTES = 1024 * 1024;

interface AgentExecution {
  execId: string;
  participantId: string;
  participantName: string;
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

const emptyOutput = (): OutputState => ({
  chunks: [],
  lastSequence: 0,
  status: "connecting",
  truncated: false,
  bufferLimitReached: false,
  outputBytes: 0,
  resyncing: false,
  resynced: false,
});

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";

function executionsFromEvents(events: SdkEvent[], participants: Participant[]): AgentExecution[] {
  const agents = new Map(
    participants
      .filter((participant) => participant.kind === "AGENT" && participant.status !== "REMOVED")
      .map((participant) => [participant.id, participant.display_name]),
  );
  const executions = new Map<string, AgentExecution>();

  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const execId = event.payload["exec_id"];
    const participantId = event.payload["participant_id"];
    if (typeof execId !== "string" || typeof participantId !== "string") continue;
    const participantName = agents.get(participantId);
    if (!participantName) continue;

    const previous = executions.get(execId);
    if (event.type === "sandbox.exec.started") {
      executions.set(execId, {
        execId,
        participantId,
        participantName,
        startedAt: event.sequence,
        finished: previous?.finished ?? false,
        ...(previous?.exitCode === undefined ? {} : { exitCode: previous.exitCode }),
      });
    } else if (event.type === "sandbox.exec.finished") {
      executions.set(execId, {
        execId,
        participantId,
        participantName,
        startedAt: previous?.startedAt ?? event.sequence,
        finished: true,
        exitCode:
          typeof event.payload["exit_code"] === "number" || event.payload["exit_code"] === null
            ? event.payload["exit_code"]
            : null,
      });
    }
  }

  return [...executions.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export default function AgentOutputView(props: {
  room: RoomClient;
  participants: Participant[];
  events: SdkEvent[];
}) {
  const { room, participants, events } = props;
  const executions = useMemo(
    () => executionsFromEvents(events, participants),
    [events, participants],
  );
  const [selectedExecId, setSelectedExecId] = useState("");
  const [outputs, setOutputs] = useState<Record<string, OutputState>>({});
  const outputBytes = useRef(new Map<string, number>());
  const outputsRef = useRef(outputs);
  const subscriptions = useRef(new Map<string, SandboxOutputSubscription>());

  useEffect(() => {
    outputsRef.current = outputs;
  }, [outputs]);

  const updateOutput = useCallback(
    (execId: string, update: (previous: OutputState) => OutputState) => {
      setOutputs((current) => ({
        ...current,
        [execId]: update(current[execId] ?? emptyOutput()),
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
          const previousBytes = outputBytes.current.get(execId) ?? 0;
          const acceptedBytes = Math.min(
            update.data.byteLength,
            Math.max(0, MAX_DISPLAY_BYTES - previousBytes),
          );
          outputBytes.current.set(execId, previousBytes + acceptedBytes);
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
            .map((stream) => ({ stream, text: sanitizeTerminalText(decoders[stream].decode()) }))
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
    if (!executions.some((execution) => execution.execId === selectedExecId))
      setSelectedExecId(executions[0]?.execId ?? "");
  }, [executions, selectedExecId]);

  const selected = executions.find((execution) => execution.execId === selectedExecId);
  const output = selectedExecId ? outputs[selectedExecId] : undefined;
  const status = output?.status ?? (selected?.finished ? "finished" : "connecting");

  return (
    <section className="agent-output-view" aria-label="Agent output">
      <h3>Agent output</h3>
      <p className="muted">Read-only output from agent sandbox commands.</p>
      {executions.length > 0 ? (
        <label>
          Agent executions
          <select
            aria-label="Agent executions"
            data-testid="agent-output-execution"
            value={selectedExecId}
            onChange={(event) => setSelectedExecId(event.target.value)}
          >
            {executions.map((execution) => (
              <option key={execution.execId} value={execution.execId}>
                {execution.participantName} · {execution.execId.slice(-8)}
                {execution.finished
                  ? ` · ${execution.exitCode === null ? "stopped" : `exit ${execution.exitCode}`}`
                  : " · running"}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="muted">No recent agent executions in this room.</p>
      )}
      {selected && (
        <div className="terminal-output-panel" data-testid="agent-output-panel">
          <div className="terminal-output-header">
            <div>
              <strong>{selected.participantName}</strong>
              <span className="muted" data-testid="agent-output-status">{` · ${status}`}</span>
              {output?.status === "finished" && (
                <span className="muted" data-testid="agent-output-result">
                  {output.exitCode === null
                    ? ` · ${output.reason ?? "stopped"}`
                    : ` · exit ${output.exitCode}`}
                  {output.reason && output.exitCode !== null ? ` · ${output.reason}` : ""}
                </span>
              )}
            </div>
          </div>
          {output?.error && (
            <p className="error" role="alert">
              Output unavailable: {output.error}
            </p>
          )}
          {output?.resyncing && (
            <p className="terminal-replay" role="status">
              Output connection interrupted; replaying from sequence {output.lastSequence}.
            </p>
          )}
          {output?.resynced && !output.resyncing && (
            <p className="terminal-replay" role="status">
              Output resumed and replayed from the last received sequence.
            </p>
          )}
          <div className="terminal-output" aria-live="polite" data-testid="agent-output-output">
            {output?.chunks.map((chunk, index) => (
              <div className={`terminal-chunk ${chunk.stream}`} key={`${index}-${chunk.stream}`}>
                <span aria-hidden="true">{chunk.stream === "stderr" ? "err" : "out"}</span>
                <pre>{chunk.text}</pre>
              </div>
            ))}
            {output?.bufferLimitReached && (
              <p className="terminal-truncated" role="status">
                Browser display capped at 1 MiB; additional output is not retained on this page.
              </p>
            )}
            {output?.truncated && !output.bufferLimitReached && (
              <p className="terminal-truncated" role="status">
                The server truncated output after reaching its execution limit.
              </p>
            )}
            {!output?.chunks.length && !output?.error && (
              <span className="muted">Waiting for output…</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
