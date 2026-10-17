import { useEffect, useMemo, useState } from "react";
import type { RoomClient, SdkEvent } from "@crossover/sdk";
import { SandboxOutputBuffer } from "@crossover/sdk";
import type { Participant } from "./model.js";
import { TerminalTextSanitizer } from "./terminal-output.js";

interface AgentExecution {
  execId: string;
  participantName: string;
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

const emptyOutput = (): OutputState => ({
  chunks: [],
  lastSequence: 0,
  status: "connecting",
  truncated: false,
  bufferLimitReached: false,
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
  return events
    .filter((event) => event.type === "sandbox.exec.started")
    .flatMap((event) => {
      const execId = event.payload["exec_id"];
      const name = agents.get(String(event.payload["participant_id"]));
      return typeof execId === "string" && name
        ? [{ execId, participantName: name, startedAt: event.sequence }]
        : [];
    })
    .sort((a, b) => b.startedAt - a.startedAt);
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
  const [output, setOutput] = useState<OutputState>();

  useEffect(() => {
    if (!selectedExecId) return;
    setOutput(emptyOutput());
    const buffer = new SandboxOutputBuffer();
    const sanitizers = {
      stdout: new TerminalTextSanitizer(),
      stderr: new TerminalTextSanitizer(),
    };
    const subscription = room.subscribeSandboxOutput(selectedExecId, {
      onState: (state) =>
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
        }),
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
          truncated: buffered.truncated,
          bufferLimitReached: buffered.bufferLimitReached,
          ...(buffered.kind === "finished"
            ? { status: "finished" as const, exitCode: buffered.exit_code, reason: buffered.reason }
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
    if (!executions.some((execution) => execution.execId === selectedExecId)) {
      setOutput(undefined);
      setSelectedExecId(executions[0]?.execId ?? "");
    }
  }, [executions, selectedExecId]);

  const selected = executions.find((execution) => execution.execId === selectedExecId);
  const status = output?.status ?? "connecting";

  return (
    <section className="agent-output-view" aria-label="Agent output">
      <h3>Agent output</h3>
      <p className="muted">Read-only output from agent sandbox commands.</p>
      {executions.length ? (
        <label>
          Agent executions
          <select
            aria-label="Agent executions"
            data-testid="agent-output-execution"
            value={selectedExecId}
            onChange={(event) => {
              // Selecting the execution that is already shown changes nothing: the subscription
              // effect would not run again, and the output cleared here would never come back.
              if (event.target.value === selectedExecId) return;
              setOutput(undefined);
              setSelectedExecId(event.target.value);
            }}
          >
            {executions.map((execution) => (
              <option key={execution.execId} value={execution.execId}>
                {execution.participantName} · {execution.execId.slice(-8)}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="muted">No recent agent executions in this room.</p>
      )}
      {selected && (
        <div className="terminal-output-panel" data-testid="agent-output-panel">
          <strong>{selected.participantName}</strong>
          <span className="muted" data-testid="agent-output-status">{` · ${status}`}</span>
          {output?.status === "finished" && (
            <span className="muted" data-testid="agent-output-result">
              {output.exitCode === null
                ? ` · ${output.reason ?? "stopped"}`
                : ` · exit ${output.exitCode}`}
            </span>
          )}
          {output?.error && (
            <p className="error" role="alert">
              Output unavailable: {output.error}
            </p>
          )}
          {output?.resyncing && <p role="status">Replaying from sequence {output.lastSequence}…</p>}
          {output?.resynced && !output.resyncing && (
            <p role="status">Output replayed after reconnect.</p>
          )}
          <div className="terminal-output" aria-live="polite" data-testid="agent-output-output">
            {output?.chunks.map((chunk, index) => (
              <div className={`terminal-chunk ${chunk.stream}`} key={`${index}-${chunk.stream}`}>
                <span aria-hidden="true">{chunk.stream === "stderr" ? "err" : "out"}</span>
                <pre>{chunk.text}</pre>
              </div>
            ))}
            {output?.bufferLimitReached && <p role="status">Browser output capped at 1 MiB.</p>}
            {output?.truncated && !output.bufferLimitReached && (
              <p role="status">Server output truncated.</p>
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
