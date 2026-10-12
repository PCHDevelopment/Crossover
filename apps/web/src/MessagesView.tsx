import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { RoomClient, SdkEvent } from "@crossover/sdk";
import type { Participant, Task } from "./model.js";

type MessageRef = { kind: "task" | "decision" | "file"; id: string };
type RoomMessage = {
  id: string;
  author_id: string;
  body: string;
  mentions: string[];
  refs: MessageRef[];
  created_at: string;
  redacted: boolean;
};
type Decision = { id: string; title: string };
type MessagePage = { messages: RoomMessage[] };
type DecisionPage = { decisions: Decision[] };
type WorkspaceEntry = { path: string; type: "file" | "directory" | "symlink" | "submodule" };
type WorkspacePage = { entries: WorkspaceEntry[] };
type RefKind = MessageRef["kind"];

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";

export default function MessagesView(props: {
  room: RoomClient;
  participants: Participant[];
  tasks: Task[];
  selfId: string;
  nameOf: (id: string) => string;
  onEvent: (listener: (event: SdkEvent) => void) => () => void;
}) {
  const { room, participants, tasks, selfId, nameOf, onEvent } = props;
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionChoice, setMentionChoice] = useState("");
  const [refs, setRefs] = useState<MessageRef[]>([]);
  const [files, setFiles] = useState<WorkspaceEntry[]>([]);
  const [fileDirectory, setFileDirectory] = useState("");
  const [refKind, setRefKind] = useState<RefKind>("task");
  const [refTarget, setRefTarget] = useState("");
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const loadMessages = useCallback(async () => {
    const page = await room.api.messages.list<MessagePage>({ limit: 100 });
    setMessages(page.response.messages);
  }, [room]);

  const loadFiles = useCallback(
    async (directory: string, clearSelection = true) => {
      const page = await room.api.workspace.list<WorkspacePage>(
        directory ? { path: directory } : {},
      );
      setFiles(page.response.entries);
      setFileDirectory(directory);
      if (clearSelection) setRefTarget("");
    },
    [room],
  );

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      loadMessages(),
      room.api.decisions.list<DecisionPage>({ limit: 100 }).then((page) => {
        if (mounted) setDecisions(page.response.decisions);
      }),
      loadFiles(""),
    ]).catch((error: unknown) => {
      if (mounted) setNotice(errorText(error));
    });
    return () => {
      mounted = false;
    };
  }, [loadFiles, loadMessages, room]);

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type.startsWith("message."))
          void loadMessages().catch((error: unknown) => setNotice(errorText(error)));
        if (event.type.startsWith("decision."))
          void room.api.decisions
            .list<DecisionPage>({ limit: 100 })
            .then((page) => setDecisions(page.response.decisions))
            .catch((error: unknown) => setNotice(errorText(error)));
        if (event.type.startsWith("workspace."))
          void loadFiles(fileDirectory, false).catch((error: unknown) =>
            setNotice(errorText(error)),
          );
      }),
    [fileDirectory, loadFiles, loadMessages, onEvent, room],
  );

  const targets = useMemo(() => {
    if (refKind === "task") return tasks.map((task) => ({ id: task.id, label: task.title }));
    if (refKind === "decision")
      return decisions.map((decision) => ({ id: decision.id, label: decision.title }));
    return [];
  }, [decisions, refKind, tasks]);

  const addMention = (id: string) => {
    const participant = participants.find((candidate) => candidate.id === id);
    if (!participant) return;
    if (!mentions.includes(id)) {
      setMentions((current) => (current.includes(id) ? current : [...current, id]));
      setBody(
        (current) =>
          `${current}${current && !/\s$/.test(current) ? " " : ""}@${participant.display_name} `,
      );
    }
    setMentionChoice("");
  };

  const addReference = () => {
    const id = refTarget;
    if (!id || refs.some((reference) => reference.kind === refKind && reference.id === id)) return;
    setRefs((current) => [...current, { kind: refKind, id }]);
    setRefTarget("");
  };

  const openFileEntry = (path: string) => {
    const entry = files.find((candidate) => candidate.path === path);
    if (!entry) return;
    if (entry.type === "directory") {
      void loadFiles(entry.path).catch((error: unknown) => setNotice(errorText(error)));
      return;
    }
    if (entry.type === "file" || entry.type === "symlink") setRefTarget(entry.path);
  };

  const goToParentDirectory = () => {
    const parent = fileDirectory.includes("/")
      ? fileDirectory.slice(0, fileDirectory.lastIndexOf("/"))
      : "";
    void loadFiles(parent).catch((error: unknown) => setNotice(errorText(error)));
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await room.api.messages.send({ body, mentions, refs });
      setBody("");
      setMentions([]);
      setRefs([]);
      await loadMessages();
    } catch (error) {
      setNotice(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const labelReference = (reference: MessageRef) => {
    const title =
      reference.kind === "task"
        ? tasks.find((task) => task.id === reference.id)?.title
        : reference.kind === "decision"
          ? decisions.find((decision) => decision.id === reference.id)?.title
          : undefined;
    return `${reference.kind}: ${title ?? reference.id}`;
  };

  return (
    <section aria-label="Room messages" data-testid="messages-view">
      <h2>Messages</h2>
      {notice && (
        <p role="alert" className="error" data-testid="messages-notice">
          {notice}
        </p>
      )}
      <ol className="list message-list" data-testid="message-list" aria-live="polite">
        {messages.map((item) => (
          <li key={item.id} data-testid="room-message">
            <div className="message-meta">
              <strong>{nameOf(item.author_id)}</strong>
              <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
            </div>
            <p>{item.redacted ? "Message removed by the room owner." : item.body}</p>
            {item.mentions.length > 0 && (
              <div className="tabs message-tags" aria-label="Mentioned participants">
                {item.mentions.map((id) => (
                  <span className="badge" key={id}>
                    @{nameOf(id)}
                  </span>
                ))}
              </div>
            )}
            {item.refs.length > 0 && (
              <div className="tabs message-tags" aria-label="Message references">
                {item.refs.map((reference) => (
                  <span
                    className="badge"
                    data-testid="message-reference"
                    key={`${reference.kind}:${reference.id}`}
                  >
                    {labelReference(reference)}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
        {messages.length === 0 && <li className="muted">No messages yet.</li>}
      </ol>
      <form className="message-composer" onSubmit={(event) => void send(event)}>
        <label>
          Message
          <textarea
            data-testid="message-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={32 * 1024}
            required
          />
        </label>
        <div className="tabs message-controls">
          <label>
            @ Mention
            <select
              data-testid="message-mention-picker"
              value={mentionChoice}
              onChange={(event) => addMention(event.target.value)}
            >
              <option value="">Choose participant</option>
              {participants
                .filter(
                  (participant) => participant.status !== "REMOVED" && participant.id !== selfId,
                )
                .map((participant) => (
                  <option key={participant.id} value={participant.id}>
                    {participant.display_name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Reference type
            <select
              data-testid="message-reference-kind"
              value={refKind}
              onChange={(event) => {
                setRefKind(event.target.value as RefKind);
                setRefTarget("");
              }}
            >
              <option value="task">Task</option>
              <option value="decision">Decision</option>
              <option value="file">File</option>
            </select>
          </label>
          {refKind === "file" ? (
            <>
              <label>
                File in {fileDirectory || "/"}
                <select
                  data-testid="message-file-target"
                  value={refTarget}
                  onChange={(event) => openFileEntry(event.target.value)}
                >
                  <option value="">Choose file or directory</option>
                  {files.map((entry) => (
                    <option key={entry.path} value={entry.path}>
                      {entry.type === "directory"
                        ? `Open ${entry.path.slice(entry.path.lastIndexOf("/") + 1)}/`
                        : entry.path}
                    </option>
                  ))}
                </select>
              </label>
              {fileDirectory && (
                <button type="button" onClick={goToParentDirectory}>
                  Parent directory
                </button>
              )}
            </>
          ) : (
            <label>
              {refKind === "task" ? "Task" : "Decision"}
              <select
                data-testid="message-reference-target"
                value={refTarget}
                onChange={(event) => setRefTarget(event.target.value)}
              >
                <option value="">Choose {refKind}</option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            data-testid="message-add-reference"
            disabled={!refTarget}
            onClick={addReference}
          >
            Add reference
          </button>
        </div>
        {(mentions.length > 0 || refs.length > 0) && (
          <div className="tabs message-tags" aria-label="Included message metadata">
            {mentions.map((id) => (
              <button
                className="badge"
                type="button"
                key={id}
                aria-label={`Remove mention of ${nameOf(id)}`}
                onClick={() => {
                  setMentions((current) => current.filter((mention) => mention !== id));
                  const token = `@${nameOf(id)} `;
                  setBody((current) => {
                    const at = current.lastIndexOf(token);
                    return at < 0
                      ? current
                      : current.slice(0, at) + current.slice(at + token.length);
                  });
                }}
              >
                × @{nameOf(id)}
              </button>
            ))}
            {refs.map((reference) => (
              <button
                className="badge"
                type="button"
                key={`${reference.kind}:${reference.id}`}
                aria-label={`Remove ${labelReference(reference)}`}
                onClick={() =>
                  setRefs((current) =>
                    current.filter(
                      (entry) => entry.kind !== reference.kind || entry.id !== reference.id,
                    ),
                  )
                }
              >
                × {labelReference(reference)}
              </button>
            ))}
          </div>
        )}
        <button data-testid="message-send" disabled={busy || !body.trim()}>
          {busy ? "Sending…" : "Send message"}
        </button>
      </form>
    </section>
  );
}
