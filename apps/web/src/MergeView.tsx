import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomClient } from "@crossover/sdk";
import { mergeRegions, resolveRegions, type Choice, type MergeRegion } from "./draft.js";
import { monaco } from "./monaco.js";

/**
 * The merge view (§13.3, T1105c): a flush came back as a Conflict. The current head ("theirs",
 * read-only) is on the left and the result, editable, on the right. It starts as a three-way merge
 * of the draft's base, the draft ("mine") and the head, with each region both sides changed
 * taken from mine; each can be switched to theirs or both, and the result edited by hand.
 * Submitting sends a RESOLUTION ChangeSet for the conflict, based on the head shown; if the head
 * moved meanwhile the view reloads against the new one. "Discard my edits" abandons the conflict.
 */

interface Head {
  content: string;
  file_revision: number;
  workspace_revision: number;
}
type ApplyResponse =
  { status: "APPLIED"; applied_revision: number } | { status: "CONFLICT"; conflict_id: string };

/** Lines a conflict marker starts with; a result that still has one isn't resolved. */
const MARKER = /^(<{7}|={7}|>{7})( |$)/m;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong";

export default function MergeView(props: {
  room: RoomClient;
  path: string;
  conflictId: string;
  base: string;
  mine: string;
  /** The resolution was applied: the file is now `content` at `fileRevision`. */
  onResolved: (content: string, fileRevision: number, workspaceRevision: number) => void;
  /** The conflict was abandoned: the file is the head, `content` at `fileRevision`. */
  onDiscarded: (content: string, fileRevision: number, workspaceRevision: number) => void;
}) {
  const { room, path, conflictId, base, mine, onResolved, onDiscarded } = props;
  const host = useRef<HTMLDivElement>(null);
  const diff = useRef<monaco.editor.IStandaloneDiffEditor>(undefined);
  const [head, setHead] = useState<Head>();
  const [regions, setRegions] = useState<MergeRegion[]>();
  const [choices, setChoices] = useState<Choice[]>([]);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const read = await room.api.workspace.read<Head & { encoding: string }>({ path });
    const loaded = mergeRegions(base, mine, read.response.content) ?? [
      // Too large to merge here: one region, the whole file.
      { kind: "conflict", base: [base], ours: [mine], theirs: [read.response.content] },
    ];
    setHead(read.response);
    setRegions(loaded);
    setChoices([]);
  }, [room, path, base, mine]);

  useEffect(() => {
    load().catch((error: unknown) => setNotice(message(error)));
  }, [load]);

  useEffect(() => {
    const created = monaco.editor.createDiffEditor(host.current!, {
      automaticLayout: true,
      originalEditable: false,
      renderSideBySide: true,
      minimap: { enabled: false },
    });
    diff.current = created;
    return () => {
      const model = created.getModel();
      created.dispose();
      model?.original.dispose();
      model?.modified.dispose();
    };
  }, []);

  // A new head: new models. A new choice: the result is rewritten from the regions.
  useEffect(() => {
    const editor = diff.current;
    if (!editor || !head || !regions) return;
    const result = resolveRegions(regions, choices);
    const current = editor.getModel();
    if (current && current.original.getValue() === head.content) {
      current.modified.setValue(result);
      return;
    }
    editor.setModel({
      original: monaco.editor.createModel(head.content, undefined),
      modified: monaco.editor.createModel(result, undefined),
    });
    current?.original.dispose();
    current?.modified.dispose();
  }, [head, regions, choices]);

  const choose = (index: number, choice: Choice) =>
    setChoices((c) => {
      const next = [...c];
      next[index] = choice;
      return next;
    });

  const submit = async () => {
    const content = diff.current?.getModel()?.modified.getValue();
    if (!head || content === undefined) return;
    if (MARKER.test(content)) {
      setNotice("The result still has conflict markers");
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const applied = await room.api.workspace.apply_changeset<ApplyResponse>({
        source: "RESOLUTION",
        conflict_id: conflictId,
        message: `Resolve ${path}`,
        base_workspace_revision: head.workspace_revision,
        base_file_revisions: { [path]: head.file_revision },
        operations: [{ type: "modify", path, content }],
      });
      if (applied.response.status === "APPLIED") {
        const revision = applied.response.applied_revision;
        const read = await room.api.workspace.read<Head>({ path, revision });
        onResolved(content, read.response.file_revision, revision);
        return;
      }
      // The head moved on while this was open: merge against the new one.
      setNotice(`${path} changed again; merge against the latest version`);
      await load();
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    try {
      await room.api.conflicts.abandon({ conflict_id: conflictId });
      const read = await room.api.workspace.read<Head>({ path });
      onDiscarded(
        read.response.content,
        read.response.file_revision,
        read.response.workspace_revision,
      );
    } catch (error) {
      setNotice(message(error));
      setBusy(false);
    }
  };

  const conflicts = (regions ?? []).filter((r) => r.kind === "conflict");
  return (
    <section aria-label={`Merge ${path}`} className="merge" data-testid="merge-view">
      <p className="muted">
        Left: {path} as it is now. Right: the result, editable. Each conflict starts with your
        version.
      </p>
      <ol className="merge-conflicts">
        {conflicts.map((_, i) => (
          <li key={i} data-testid="merge-conflict">
            Conflict {i + 1}:{" "}
            {(["ours", "theirs", "both"] as const).map((choice) => (
              <button
                key={choice}
                data-testid={`take-${choice}`}
                aria-pressed={(choices[i] ?? "ours") === choice}
                onClick={() => choose(i, choice)}
              >
                {choice === "ours" ? "Mine" : choice === "theirs" ? "Theirs" : "Both"}
              </button>
            ))}
          </li>
        ))}
      </ol>
      {notice && (
        <p role="alert" className="error" data-testid="merge-notice">
          {notice}
        </p>
      )}
      <div ref={host} className="editor" data-testid="merge-editor" />
      <p>
        <button data-testid="merge-submit" disabled={busy || !head} onClick={() => void submit()}>
          Submit resolution
        </button>{" "}
        <button data-testid="merge-discard" disabled={busy} onClick={() => void discard()}>
          Discard my edits
        </button>
      </p>
    </section>
  );
}
