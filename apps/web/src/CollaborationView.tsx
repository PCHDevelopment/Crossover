import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { RoomClient, SdkEvent } from "@crossover/sdk";

type Provenance = { author_id: string; author_kind: "HUMAN" | "AGENT" | "SYSTEM"; trust: string };
type DecisionOption = { id: string; summary: string; detail: string };
type Position = {
  participant_id: string;
  option_id: string;
  argument: string;
  provenance: Provenance;
};
type Decision = {
  id: string;
  title: string;
  context: string;
  options: DecisionOption[];
  status: string;
  outcome_option_id: string | null;
  rationale: string | null;
  decided_at?: string | null;
  proposed_by: string;
  provenance: Provenance;
  version: number;
  position_count?: number;
  positions?: Position[];
};
type MemorySummary = {
  key: string;
  content_type: string;
  author_id: string;
  revision: number;
  bytes: number;
  deleted: boolean;
  redacted: boolean;
  provenance: Provenance;
};
type MemoryEntry = MemorySummary & {
  value: string;
  source_refs: { kind: string; id: string }[];
};
type MemoryRevision = {
  revision: number;
  value: string;
  content_type: string;
  author_id: string;
  source_refs: { kind: string; id: string }[];
  deleted: boolean;
  redacted: boolean;
  created_at: string;
  provenance: Provenance;
};

type InboxItem = {
  id: string;
  kind: string;
  summary: string;
  created_at: string;
  acked_at: string | null;
  provenance: Provenance;
};

type Section = "inbox" | "decisions" | "memory";
const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";

export default function CollaborationView(props: {
  room: RoomClient;
  selfId: string;
  canPropose: boolean;
  canPosition: boolean;
  canDecide: boolean;
  canWriteMemory: boolean;
  canVeto: boolean;
  nameOf: (id: string) => string;
  onEvent: (listener: (event: SdkEvent) => void) => () => void;
}) {
  const {
    room,
    selfId,
    canPropose,
    canPosition,
    canDecide,
    canWriteMemory,
    canVeto,
    nameOf,
    onEvent,
  } = props;
  const [section, setSection] = useState<Section>("decisions");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [selectedDecision, setSelectedDecision] = useState<Decision>();
  const [decisionTitle, setDecisionTitle] = useState("");
  const [decisionContext, setDecisionContext] = useState("");
  const [decisionOptions, setDecisionOptions] = useState("");
  const [positionOptions, setPositionOptions] = useState<Record<string, string>>({});
  const [positionArguments, setPositionArguments] = useState<Record<string, string>>({});
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [rationales, setRationales] = useState<Record<string, string>>({});
  const [vetoRationales, setVetoRationales] = useState<Record<string, string>>({});
  const [memoryPrefix, setMemoryPrefix] = useState("");
  const [memory, setMemory] = useState<MemorySummary[]>([]);
  const [memoryKey, setMemoryKey] = useState<string>();
  const [memoryEntry, setMemoryEntry] = useState<MemoryEntry>();
  const [memoryHistory, setMemoryHistory] = useState<MemoryRevision[]>([]);
  const [memoryWriteKey, setMemoryWriteKey] = useState("");
  const [memoryWriteValue, setMemoryWriteValue] = useState("");
  const [memoryWriteType, setMemoryWriteType] = useState<"text/markdown" | "application/json">(
    "text/markdown",
  );
  const [memorySourceRefs, setMemorySourceRefs] = useState("");

  const loadDecisions = useCallback(async () => {
    const page = await room.api.decisions.list<{ decisions: Decision[] }>({ limit: 100 });
    setDecisions(page.response.decisions);
  }, [room]);
  const loadInbox = useCallback(async () => {
    const page = await room.api.inbox.list<{ items: InboxItem[] }>({
      unacked_only: true,
      limit: 100,
    });
    setInbox(page.response.items);
  }, [room]);
  const loadDecision = useCallback(
    async (id: string) => {
      const detail = await room.api.decisions.get<Decision>({ decision_id: id });
      setSelectedDecision(detail.response);
    },
    [room],
  );
  const loadMemory = useCallback(
    async (prefix = "") => {
      const page = await room.api.memory.list<{ entries: MemorySummary[] }>({
        prefix: prefix.trim(),
        limit: 100,
      });
      setMemory(page.response.entries);
    },
    [room],
  );
  const loadMemoryDetail = useCallback(
    async (key: string) => {
      const [entry, history] = await Promise.all([
        room.api.memory.get<MemoryEntry>({ key }),
        room.api.memory.history<{ revisions: MemoryRevision[] }>({ key, limit: 100 }),
      ]);
      setMemoryEntry(entry.response);
      setMemoryHistory(history.response.revisions);
      return entry.response;
    },
    [room],
  );

  useEffect(() => {
    void Promise.allSettled([loadInbox(), loadDecisions(), loadMemory()]).then((results) => {
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") setNotice(message(failed.reason));
    });
  }, [loadDecisions, loadInbox, loadMemory]);

  useEffect(() => {
    const unsubscribe = onEvent((event) => {
      if (event.type === "inbox.delivered" && event.payload["recipient_id"] === selfId) {
        void loadInbox().catch((error: unknown) => setNotice(message(error)));
      }
      if (event.type.startsWith("decision.")) {
        void loadDecisions().catch((error: unknown) => setNotice(message(error)));
        if (selectedDecision?.id) {
          void loadDecision(selectedDecision.id).catch((error: unknown) =>
            setNotice(message(error)),
          );
        }
      }
      if (event.type.startsWith("memory.")) {
        void loadMemory(memoryPrefix).catch((error: unknown) => setNotice(message(error)));
        if (memoryKey) {
          void loadMemoryDetail(memoryKey).catch((error: unknown) => {
            setMemoryEntry(undefined);
            setMemoryHistory([]);
            setNotice(message(error));
          });
        }
      }
    });
    return () => {
      unsubscribe();
    };
  }, [
    loadInbox,
    selfId,
    loadDecision,
    loadDecisions,
    loadMemory,
    loadMemoryDetail,
    memoryKey,
    memoryPrefix,
    onEvent,
    selectedDecision?.id,
  ]);

  const propose = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const options = decisionOptions
      .split("\n")
      .map((summary) => summary.trim())
      .filter(Boolean)
      .map((summary) => ({ summary, detail: "" }));
    setBusy("propose");
    setNotice(undefined);
    try {
      const created = await room.api.decisions.propose<Decision>({
        title: decisionTitle,
        context: decisionContext,
        options,
      });
      setDecisionTitle("");
      setDecisionContext("");
      setDecisionOptions("");
      await Promise.all([loadDecisions(), loadDecision(created.response.id)]);
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  };

  const addPosition = async (event: FormEvent<HTMLFormElement>, decision: Decision) => {
    event.preventDefault();
    const optionId = positionOptions[decision.id] ?? decision.options[0]?.id ?? "";
    setBusy(`position:${decision.id}`);
    setNotice(undefined);
    try {
      await room.api.decisions.add_position({
        decision_id: decision.id,
        option_id: optionId,
        argument: positionArguments[decision.id] ?? "",
      });
      await Promise.all([loadDecisions(), loadDecision(decision.id)]);
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  };

  const decide = async (event: FormEvent<HTMLFormElement>, decision: Decision) => {
    event.preventDefault();
    const outcome = outcomes[decision.id] ?? decision.options[0]?.id ?? "";
    setBusy(`decide:${decision.id}`);
    setNotice(undefined);
    try {
      await room.api.decisions.decide({
        decision_id: decision.id,
        expected_version: decision.version,
        ...(outcome === "reject" ? { reject: true } : { outcome_option_id: outcome }),
        rationale: rationales[decision.id] ?? "",
      });
      await Promise.all([loadDecisions(), loadDecision(decision.id), loadMemory(memoryPrefix)]);
    } catch (error) {
      setNotice(message(error));
      void loadDecision(decision.id).catch(() => undefined);
    } finally {
      setBusy(undefined);
    }
  };

  const writeMemory = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = memoryWriteKey.trim();
    setBusy("memory:write");
    setNotice(undefined);
    try {
      const source_refs = memorySourceRefs
        .split("\n")
        .map((reference) => reference.trim())
        .filter(Boolean)
        .map((reference) => {
          const separator = reference.indexOf(":");
          if (separator < 1 || separator === reference.length - 1)
            throw new Error("Write each source reference as kind:id on its own line.");
          return {
            kind: reference.slice(0, separator).trim(),
            id: reference.slice(separator + 1).trim(),
          };
        });
      const expected_revision = memoryEntry?.key === key ? memoryEntry.revision : 0;
      await room.api.memory.put({
        key,
        value: memoryWriteValue,
        content_type: memoryWriteType,
        expected_revision,
        source_refs,
      });
      setMemoryKey(key);
      await Promise.all([loadMemory(memoryPrefix), loadMemoryDetail(key)]);
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  };

  const withdraw = async (decision: Decision) => {
    setBusy(`withdraw:${decision.id}`);
    setNotice(undefined);
    try {
      await room.api.decisions.withdraw({
        decision_id: decision.id,
        expected_version: decision.version,
      });
      await Promise.all([loadDecisions(), loadDecision(decision.id)]);
    } catch (error) {
      setNotice(message(error));
      void loadDecision(decision.id).catch(() => undefined);
    } finally {
      setBusy(undefined);
    }
  };

  const veto = async (event: FormEvent<HTMLFormElement>, decision: Decision) => {
    event.preventDefault();
    setBusy(`veto:${decision.id}`);
    setNotice(undefined);
    try {
      await room.api.decisions.veto({
        decision_id: decision.id,
        expected_version: decision.version,
        rationale: vetoRationales[decision.id] ?? "",
      });
      await Promise.all([loadDecisions(), loadDecision(decision.id), loadMemory(memoryPrefix)]);
    } catch (error) {
      setNotice(message(error));
      void loadDecision(decision.id).catch(() => undefined);
    } finally {
      setBusy(undefined);
    }
  };

  const selectMemory = async (key: string) => {
    setMemoryKey(key);
    setMemoryEntry(undefined);
    setMemoryHistory([]);
    setNotice(undefined);
    try {
      const entry = await loadMemoryDetail(key);
      setMemoryWriteKey(entry.key);
      setMemoryWriteValue(entry.redacted ? "" : entry.value);
      setMemoryWriteType(entry.content_type as "text/markdown" | "application/json");
      setMemorySourceRefs(
        entry.source_refs.map((source) => `${source.kind}:${source.id}`).join("\n"),
      );
    } catch (error) {
      setNotice(message(error));
    }
  };

  const acknowledge = async (id: string) => {
    setBusy(`ack:${id}`);
    setNotice(undefined);
    try {
      await room.api.inbox.ack({ ids: [id] });
      await loadInbox();
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section aria-label="Collaboration" data-testid="collaboration-view">
      <h2>Inbox, decisions and memory</h2>
      <nav className="tabs" aria-label="Inbox, decisions and memory sections">
        {(["inbox", "decisions", "memory"] as const).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={section === id}
            data-testid={`collab-${id}`}
            onClick={() => setSection(id)}
          >
            {id[0]!.toUpperCase() + id.slice(1)}
          </button>
        ))}
      </nav>
      {notice && (
        <p role="alert" className="error" data-testid="collaboration-notice">
          {notice}
        </p>
      )}

      {section === "inbox" && (
        <section aria-label="Inbox">
          <h3>Inbox</h3>
          <ul className="list" data-testid="inbox-list">
            {inbox.map((item) => (
              <li key={item.id} data-testid="inbox-item">
                <strong>{item.kind}</strong>
                <p>{item.summary}</p>
                <p className="muted">
                  From {nameOf(item.provenance.author_id)} · {item.provenance.author_kind} · trust:{" "}
                  {item.provenance.trust}
                </p>
                <button
                  disabled={busy !== undefined}
                  onClick={() => void acknowledge(item.id)}
                  data-testid="inbox-ack"
                >
                  Acknowledge
                </button>
              </li>
            ))}
            {inbox.length === 0 && <li className="muted">No unacknowledged inbox items.</li>}
          </ul>
        </section>
      )}

      {section === "decisions" && (
        <section aria-label="Decisions">
          <h3>Decisions</h3>
          {canPropose && (
            <form onSubmit={(event) => void propose(event)} data-testid="decision-propose-form">
              <label>
                Title
                <input
                  value={decisionTitle}
                  onChange={(event) => setDecisionTitle(event.target.value)}
                  maxLength={200}
                  required
                  data-testid="decision-title"
                />
              </label>
              <label>
                Context
                <textarea
                  value={decisionContext}
                  onChange={(event) => setDecisionContext(event.target.value)}
                  maxLength={20_000}
                  data-testid="decision-context"
                />
              </label>
              <label>
                Options (one per line; at least two)
                <textarea
                  value={decisionOptions}
                  onChange={(event) => setDecisionOptions(event.target.value)}
                  required
                  data-testid="decision-options"
                />
              </label>
              <button disabled={busy !== undefined} data-testid="decision-propose">
                Propose decision
              </button>
            </form>
          )}
          <ul className="list" data-testid="decision-list">
            {decisions.map((decision) => (
              <li key={decision.id}>
                <button
                  aria-pressed={selectedDecision?.id === decision.id}
                  data-testid="decision-select"
                  onClick={() => {
                    setNotice(undefined);
                    void loadDecision(decision.id).catch((error: unknown) =>
                      setNotice(message(error)),
                    );
                  }}
                >
                  {decision.title} · {decision.status} ({decision.position_count ?? 0} positions)
                </button>
              </li>
            ))}
            {decisions.length === 0 && <li className="muted">No decisions yet.</li>}
          </ul>
          {selectedDecision && (
            <article className="delivery-card" data-testid="decision-detail">
              <h4>{selectedDecision.title}</h4>
              <p>{selectedDecision.context}</p>
              <p className="muted">
                {selectedDecision.status} · proposed by{" "}
                {nameOf(selectedDecision.provenance.author_id)} ·{" "}
                {selectedDecision.provenance.author_kind} · trust:{" "}
                {selectedDecision.provenance.trust}
              </p>
              {selectedDecision.status === "PROPOSED" &&
                selectedDecision.proposed_by === selfId &&
                canPropose && (
                  <button
                    disabled={busy !== undefined}
                    data-testid="decision-withdraw"
                    onClick={() => void withdraw(selectedDecision)}
                  >
                    Withdraw decision
                  </button>
                )}
              <ol>
                {selectedDecision.options.map((option) => (
                  <li key={option.id}>
                    <strong>{option.summary}</strong> <span className="muted">({option.id})</span>
                    {option.detail && <p>{option.detail}</p>}
                  </li>
                ))}
              </ol>
              <h4>Positions</h4>
              <ul>
                {(selectedDecision.positions ?? []).map((position, index) => (
                  <li key={`${position.participant_id}-${index}`}>
                    {nameOf(position.participant_id)}
                    {position.participant_id === selfId ? " (you)" : ""} chose {position.option_id}:{" "}
                    {position.argument}{" "}
                    <span className="muted">
                      ({position.provenance.author_kind} · trust: {position.provenance.trust})
                    </span>
                  </li>
                ))}
                {(selectedDecision.positions ?? []).length === 0 && (
                  <li className="muted">No positions yet.</li>
                )}
              </ul>
              {selectedDecision.status === "PROPOSED" && canPosition && (
                <form onSubmit={(event) => void addPosition(event, selectedDecision)}>
                  <label>
                    Your position
                    <select
                      value={
                        positionOptions[selectedDecision.id] ??
                        selectedDecision.options[0]?.id ??
                        ""
                      }
                      onChange={(event) =>
                        setPositionOptions((current) => ({
                          ...current,
                          [selectedDecision.id]: event.target.value,
                        }))
                      }
                      data-testid="position-option"
                    >
                      {selectedDecision.options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.summary}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Argument
                    <textarea
                      value={positionArguments[selectedDecision.id] ?? ""}
                      onChange={(event) =>
                        setPositionArguments((current) => ({
                          ...current,
                          [selectedDecision.id]: event.target.value,
                        }))
                      }
                      maxLength={10_000}
                      required
                      data-testid="position-argument"
                    />
                  </label>
                  <button disabled={busy !== undefined} data-testid="add-position">
                    Add position
                  </button>
                </form>
              )}
              {selectedDecision.status === "PROPOSED" && canDecide && (
                <form onSubmit={(event) => void decide(event, selectedDecision)}>
                  <label>
                    Outcome
                    <select
                      value={outcomes[selectedDecision.id] ?? selectedDecision.options[0]?.id ?? ""}
                      onChange={(event) =>
                        setOutcomes((current) => ({
                          ...current,
                          [selectedDecision.id]: event.target.value,
                        }))
                      }
                      data-testid="decision-outcome"
                    >
                      {selectedDecision.options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.summary}
                        </option>
                      ))}
                      <option value="reject">Reject proposal</option>
                    </select>
                  </label>
                  <label>
                    Rationale
                    <textarea
                      value={rationales[selectedDecision.id] ?? ""}
                      onChange={(event) =>
                        setRationales((current) => ({
                          ...current,
                          [selectedDecision.id]: event.target.value,
                        }))
                      }
                      maxLength={10_000}
                      required
                      data-testid="decision-rationale"
                    />
                  </label>
                  <button disabled={busy !== undefined} data-testid="decide">
                    Record decision
                  </button>
                </form>
              )}
              {canVeto &&
                (selectedDecision.status === "ACCEPTED" ||
                  selectedDecision.status === "REJECTED") &&
                selectedDecision.decided_at &&
                Date.now() >= Date.parse(selectedDecision.decided_at) &&
                Date.now() - Date.parse(selectedDecision.decided_at) < 24 * 60 * 60 * 1000 && (
                  <form onSubmit={(event) => void veto(event, selectedDecision)}>
                    <label>
                      Veto rationale
                      <textarea
                        value={vetoRationales[selectedDecision.id] ?? ""}
                        onChange={(event) =>
                          setVetoRationales((current) => ({
                            ...current,
                            [selectedDecision.id]: event.target.value,
                          }))
                        }
                        maxLength={10_000}
                        required
                        data-testid="decision-veto-rationale"
                      />
                    </label>
                    <button disabled={busy !== undefined} data-testid="decision-veto">
                      Veto decision
                    </button>
                  </form>
                )}
              {selectedDecision.status !== "PROPOSED" && selectedDecision.rationale && (
                <p>Rationale: {selectedDecision.rationale}</p>
              )}
            </article>
          )}
        </section>
      )}

      {section === "memory" && (
        <section aria-label="Shared memory">
          <h3>Shared memory</h3>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void loadMemory(memoryPrefix).catch((error: unknown) => setNotice(message(error)));
            }}
          >
            <label>
              Filter by key prefix
              <input
                value={memoryPrefix}
                onChange={(event) => setMemoryPrefix(event.target.value)}
                maxLength={200}
                data-testid="memory-prefix"
              />
            </label>
            <button data-testid="memory-filter">Filter</button>
          </form>
          {canWriteMemory && (
            <form onSubmit={(event) => void writeMemory(event)} data-testid="memory-write-form">
              <label>
                Key
                <input
                  value={memoryWriteKey}
                  onChange={(event) => setMemoryWriteKey(event.target.value)}
                  maxLength={200}
                  required
                  data-testid="memory-write-key"
                />
              </label>
              <label>
                Content type
                <select
                  value={memoryWriteType}
                  onChange={(event) =>
                    setMemoryWriteType(event.target.value as "text/markdown" | "application/json")
                  }
                  data-testid="memory-write-type"
                >
                  <option value="text/markdown">Markdown text</option>
                  <option value="application/json">JSON</option>
                </select>
              </label>
              <label>
                Value
                <textarea
                  value={memoryWriteValue}
                  onChange={(event) => setMemoryWriteValue(event.target.value)}
                  maxLength={65_536}
                  required
                  data-testid="memory-write-value"
                />
              </label>
              <label>
                Source references (kind:id, one per line)
                <textarea
                  value={memorySourceRefs}
                  onChange={(event) => setMemorySourceRefs(event.target.value)}
                  data-testid="memory-source-refs"
                />
              </label>
              <button disabled={busy !== undefined} data-testid="memory-write">
                {busy === "memory:write" ? "Saving…" : "Write shared memory"}
              </button>
            </form>
          )}
          <ul className="list" data-testid="memory-list">
            {memory.map((entry) => (
              <li key={entry.key}>
                <button
                  aria-pressed={memoryKey === entry.key}
                  data-testid="memory-key"
                  onClick={() => void selectMemory(entry.key)}
                >
                  {entry.key} · r{entry.revision} · {entry.bytes} bytes
                </button>
                <span className="muted">
                  {" "}
                  · {nameOf(entry.provenance.author_id)} · {entry.provenance.author_kind} · trust:{" "}
                  {entry.provenance.trust}
                </span>
              </li>
            ))}
            {memory.length === 0 && <li className="muted">No shared memory entries.</li>}
          </ul>
          {memoryEntry && (
            <article className="delivery-card" data-testid="memory-detail">
              <h4>{memoryEntry.key}</h4>
              <p className="muted">
                Revision {memoryEntry.revision} · {memoryEntry.content_type} · from{" "}
                {nameOf(memoryEntry.provenance.author_id)} · {memoryEntry.provenance.author_kind} ·
                trust: {memoryEntry.provenance.trust}
              </p>
              <pre>{memoryEntry.redacted ? "[redacted by owner]" : memoryEntry.value}</pre>
              {memoryEntry.source_refs.length > 0 && (
                <p>
                  Sources:{" "}
                  {memoryEntry.source_refs
                    .map((source) => `${source.kind} ${source.id}`)
                    .join(", ")}
                </p>
              )}
              <h4>History</h4>
              <ol data-testid="memory-history">
                {memoryHistory.map((revision) => (
                  <li key={revision.revision}>
                    r{revision.revision} · {revision.deleted ? "deleted" : revision.content_type} ·{" "}
                    {nameOf(revision.provenance.author_id)} · {revision.provenance.author_kind} ·
                    trust: {revision.provenance.trust}
                    {revision.deleted ? null : (
                      <pre>{revision.redacted ? "[redacted by owner]" : revision.value}</pre>
                    )}
                  </li>
                ))}
              </ol>
            </article>
          )}
        </section>
      )}
    </section>
  );
}
