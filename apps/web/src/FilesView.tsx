import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { RoomClient, SdkEvent } from "@crossover/sdk";
import {
  applyIncoming,
  edit,
  flushed,
  flushParams,
  isDirty,
  nextFlushAt,
  openDraft,
  type Draft,
} from "./draft.js";
import { monaco } from "./monaco.js";
import {
  colorOf,
  cursorsOn,
  PresenceSender,
  viewersByPath,
  type OwnPresence,
  type PresenceMap,
} from "./presence.js";

/**
 * The Files tab (§13, T1105a): a tree from `workspace.list`, a Monaco editor, and one draft per
 * opened file. Drafts flush as `EDITOR` ChangeSets on the §13.2 timers, on Ctrl/Cmd+S, when
 * switching files and when the tab is hidden; someone else's ChangeSet on an open file replaces,
 * rebases or flags the buffer (§13.3). Conflicts get a banner; the merge view is T1105c.
 *
 * Presence (§13.4, T1105b): this tab reports its open files and cursor, and everyone else's
 * cursors and selections on the open file are drawn in their colour, named on hover; the tree
 * marks the files others have open.
 */

interface Entry {
  path: string;
  type: "file" | "directory" | "symlink" | "submodule";
  file_revision?: number;
}
interface ListResponse {
  workspace_revision: number;
  entries: Entry[];
}
interface ReadResponse {
  content: string;
  encoding: "utf8" | "base64";
  file_revision: number;
  workspace_revision: number;
}
type ApplyResponse =
  { status: "APPLIED"; applied_revision: number } | { status: "CONFLICT"; conflict_id: string };

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";
const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export default function FilesView(props: {
  room: RoomClient;
  onEvent: (listener: (event: SdkEvent) => void) => () => void;
  presence: PresenceMap;
  selfId: string;
  nameOf: (participantId: string) => string;
}) {
  const { room, onEvent, presence, selfId, nameOf } = props;
  const [dirs, setDirs] = useState(new Map<string, Entry[]>());
  const [expanded, setExpanded] = useState(new Set<string>([""]));
  const [current, setCurrent] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [, rerender] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>(undefined);
  const drafts = useRef(new Map<string, Draft>());
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(new Set<string>());
  /** Flushes asked for while one was in flight: they run as soon as it ends. */
  const requested = useRef(new Set<string>());
  const loaded = useRef(new Set<string>());
  const applying = useRef(false);
  const sender = useRef<PresenceSender>(undefined);
  const remote = useRef<monaco.editor.IEditorDecorationsCollection>(undefined);

  /** Tell the room which files are open here and where the cursor is. */
  const report = useCallback(() => {
    const ed = editor.current;
    const path = ed?.getModel()?.uri.path.slice(1);
    const selection = ed?.getSelection();
    const value: OwnPresence = {
      status: "active",
      // The file in front last: it is the one kept if more than the limit are open.
      open_files: [
        ...[...models.current.keys()].filter((p) => p !== path),
        ...(path ? [path] : []),
      ],
      cursor:
        path && selection
          ? {
              path,
              line: selection.positionLineNumber,
              column: selection.positionColumn,
              ...(selection.isEmpty()
                ? {}
                : {
                    selection: {
                      start_line: selection.startLineNumber,
                      start_column: selection.startColumn,
                      end_line: selection.endLineNumber,
                      end_column: selection.endColumn,
                    },
                  }),
            }
          : null,
    };
    sender.current?.set(value);
  }, []);

  const setDraft = useCallback((draft: Draft) => {
    drafts.current.set(draft.path, draft);
    rerender((n) => n + 1);
  }, []);

  /** Put `text` in the file's model without it counting as typing; the cursor stays put. */
  const showText = useCallback((path: string, text: string) => {
    const model = models.current.get(path);
    if (!model || model.getValue() === text) return;
    const view = editor.current?.getModel() === model ? editor.current.saveViewState() : null;
    applying.current = true;
    try {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    } finally {
      applying.current = false;
    }
    if (view) editor.current?.restoreViewState(view);
  }, []);

  const flush = useCallback(
    async (path: string) => {
      clearTimeout(timers.current.get(path));
      const draft = drafts.current.get(path);
      if (inFlight.current.has(path)) {
        requested.current.add(path);
        return;
      }
      if (!draft || !isDirty(draft)) return;
      inFlight.current.add(path);
      rerender((n) => n + 1);
      const sent = draft.text;
      let failed = false;
      try {
        const applied = await room.api.workspace.apply_changeset<ApplyResponse>(flushParams(draft));
        if (applied.response.status === "APPLIED") {
          const revision = applied.response.applied_revision;
          const read = await room.api.workspace.read<ReadResponse>({ path, revision });
          const now = drafts.current.get(path)!;
          // An incoming change may already have rebased the buffer onto this revision or later.
          if (read.response.file_revision > now.baseRevision)
            setDraft(flushed(now, sent, read.response.file_revision, revision));
        } else {
          setDraft({ ...drafts.current.get(path)!, conflicted: true });
        }
      } catch (error) {
        failed = true;
        setNotice(message(error));
      } finally {
        inFlight.current.delete(path);
        rerender((n) => n + 1);
      }
      // After a failure the draft waits for the next edit or save, not a timer already due.
      if (requested.current.delete(path)) void flush(path);
      else if (!failed) schedule(path);
    },
    [room, setDraft],
  );

  /** Arm the §13.2 timer. A conflicted draft flushes only on an explicit save. */
  const schedule = (path: string) => {
    clearTimeout(timers.current.get(path));
    const draft = drafts.current.get(path);
    const at = draft && !draft.conflicted ? nextFlushAt(draft) : undefined;
    if (at !== undefined)
      timers.current.set(
        path,
        setTimeout(() => void flush(path), Math.max(0, at - Date.now())),
      );
  };

  const flushAll = useCallback(() => {
    for (const path of drafts.current.keys()) void flush(path);
  }, [flush]);

  /** Load a folder of the tree; a refresh of one that has gone just drops it. */
  const list = useCallback(
    async (dir: string, refresh = false) => {
      try {
        const res = await room.api.workspace.list<ListResponse>(dir ? { path: dir } : {});
        loaded.current.add(dir);
        setDirs((d) => new Map(d).set(dir, res.response.entries));
      } catch (error) {
        if (!refresh) setNotice(message(error));
        else if (dir) {
          loaded.current.delete(dir);
          setDirs((d) => {
            const next = new Map(d);
            next.delete(dir);
            return next;
          });
        }
      }
    },
    [room],
  );

  // The editor, the root of the tree, and flushing when the tab is hidden or closed.
  useEffect(() => {
    const created = monaco.editor.create(host.current!, {
      model: null,
      automaticLayout: true,
      minimap: { enabled: false },
    });
    editor.current = created;
    remote.current = created.createDecorationsCollection();
    const own = new PresenceSender((value) => room.api.presence.update(value));
    sender.current = own;
    created.onDidChangeCursorSelection(report);
    created.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const path = created.getModel()?.uri.path.slice(1);
      if (path) void flush(path);
    });
    void list("");
    const hidden = () => {
      if (document.visibilityState === "hidden") flushAll();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", flushAll);
    const ownedModels = models.current;
    const ownedTimers = timers.current;
    return () => {
      own.stop({ status: "active", open_files: [], cursor: null });
      flushAll();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", flushAll);
      for (const timer of ownedTimers.values()) clearTimeout(timer);
      created.dispose();
      for (const model of ownedModels.values()) model.dispose();
      ownedModels.clear();
    };
  }, [flush, flushAll, list, room, report]);

  // Everyone else's cursor and selection on the file in front.
  useEffect(() => {
    if (!current) {
      remote.current?.clear();
      return;
    }
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    for (const c of cursorsOn(presence, current, selfId, nameOf)) {
      const hoverMessage = { value: c.name };
      decorations.push({
        range: new monaco.Range(c.line, c.column, c.line, c.column),
        options: {
          beforeContentClassName: `remote-caret presence-${c.color}`,
          hoverMessage,
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
      if (c.selection)
        decorations.push({
          range: new monaco.Range(
            c.selection.start_line,
            c.selection.start_column,
            c.selection.end_line,
            c.selection.end_column,
          ),
          options: { className: `remote-selection presence-${c.color}`, hoverMessage },
        });
    }
    remote.current?.set(decorations);
  }, [presence, current, selfId, nameOf]);

  // Someone's ChangeSet landed: re-read every open file, one event at a time.
  useEffect(() => {
    let chain = Promise.resolve();
    return onEvent((event) => {
      if (event.type !== "workspace.changeset.applied") return;
      chain = chain.then(async () => {
        for (const path of drafts.current.keys()) {
          try {
            const read = await room.api.workspace.read<ReadResponse>({ path });
            if (read.response.encoding !== "utf8") continue;
            const { draft } = applyIncoming(
              drafts.current.get(path)!,
              read.response.content,
              read.response.file_revision,
              read.response.workspace_revision,
            );
            setDraft(draft);
            showText(path, draft.text);
            schedule(path);
          } catch {
            // deleted or no longer readable: the buffer stays as it is
          }
        }
        for (const dir of loaded.current) void list(dir, true);
      });
    });
  }, [onEvent, room, setDraft, showText, list]);

  const open = async (path: string) => {
    setNotice(undefined);
    const previous = editor.current?.getModel()?.uri.path.slice(1);
    if (previous && previous !== path) void flush(previous);
    let model = models.current.get(path);
    if (!model) {
      try {
        const read = await room.api.workspace.read<ReadResponse>({ path });
        if (read.response.encoding !== "utf8") {
          setNotice(`${path} is binary and can't be edited here`);
          return;
        }
        const draft = openDraft(
          path,
          read.response.file_revision,
          read.response.content,
          read.response.workspace_revision,
        );
        model = monaco.editor.createModel(draft.text, undefined, monaco.Uri.file(path));
        models.current.set(path, model);
        setDraft(draft);
        model.onDidChangeContent(() => {
          if (applying.current) return;
          setDraft(edit(drafts.current.get(path)!, model!.getValue(), Date.now()));
          schedule(path);
        });
      } catch (error) {
        setNotice(message(error));
        return;
      }
    }
    editor.current?.setModel(model);
    setCurrent(path);
    report();
  };

  const toggle = (dir: string) => {
    const next = new Set(expanded);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      if (!dirs.has(dir)) void list(dir);
    }
    setExpanded(next);
  };

  const viewers = viewersByPath(presence, selfId);
  const tree = (dir: string, depth: number): ReactNode =>
    (dirs.get(dir) ?? []).map((entry) => {
      const draft = drafts.current.get(entry.path);
      return (
        <li key={entry.path} style={{ paddingLeft: depth * 12 }}>
          {entry.type === "directory" ? (
            <>
              <button className="link" data-testid="tree-dir" onClick={() => toggle(entry.path)}>
                {expanded.has(entry.path) ? "▾" : "▸"} {name(entry.path)}
              </button>
              {expanded.has(entry.path) && <ul className="tree">{tree(entry.path, depth + 1)}</ul>}
            </>
          ) : entry.type === "file" ? (
            <button
              className="link"
              data-testid="tree-file"
              data-path={entry.path}
              aria-current={entry.path === current}
              onClick={() => void open(entry.path)}
            >
              {name(entry.path)}
              {draft && isDirty(draft) && <span title="Unsaved draft"> ●</span>}
              {(viewers.get(entry.path) ?? []).map((id) => (
                <span
                  key={id}
                  className={`presence-dot presence-${colorOf(id)}`}
                  data-testid="file-viewer"
                  title={`${nameOf(id)} has this open`}
                />
              ))}
            </button>
          ) : (
            <span className="muted">{name(entry.path)}</span>
          )}
        </li>
      );
    });

  const draft = current ? drafts.current.get(current) : undefined;
  return (
    <section aria-label="Files" className="files">
      <ul className="tree" data-testid="file-tree">
        {tree("", 0)}
      </ul>
      <div className="editor-pane">
        <p className="muted" data-testid="editor-path">
          {current ?? "Open a file"}
          {draft && isDirty(draft) && (
            <span className="badge" data-testid="draft-indicator">
              {inFlight.current.has(draft.path) ? "saving…" : "draft"}
            </span>
          )}
        </p>
        {draft?.conflicted && (
          <p role="alert" className="error" data-testid="conflict-banner">
            {name(draft.path)} changed underneath you. Your edits are kept here.
          </p>
        )}
        {notice && (
          <p role="alert" className="error" data-testid="files-notice">
            {notice}
          </p>
        )}
        <div ref={host} className="editor" data-testid="editor" />
      </div>
    </section>
  );
}
