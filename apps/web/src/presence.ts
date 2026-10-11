import type { PresenceRecord, PresenceUpdate } from "@crossover/sdk";

/**
 * Live presence in the browser (§13.4, T1105b): who has which files open and where their cursor
 * is. Free of any UI: the records the room view keeps, what the editor draws for a file, and
 * the sender that keeps this tab's own record fresh without passing the server's rate limit.
 */

/** Distinct cursor colours; a participant keeps theirs (`presence-N` in the stylesheet). */
export const PRESENCE_COLORS = 8;

/** Clients re-send their record this often; it lives 45 s on the server (§13.4). */
export const HEARTBEAT_MS = 15_000;
/** At most one update per this long: 10 a second, half the server's limit of 20. */
export const MIN_INTERVAL_MS = 100;
/** The server takes at most this many open files. */
export const MAX_OPEN_FILES = 20;
/** A send that failed is tried again after this long. */
export const RETRY_MS = 1_000;

export type PresenceMap = ReadonlyMap<string, PresenceRecord>;

/** Fold an update into the records: a snapshot replaces them all, a record replaces its own. */
export function applyPresence(records: PresenceMap, update: PresenceUpdate): PresenceMap {
  if ("snapshot" in update) return new Map(update.snapshot.map((r) => [r.participant_id, r]));
  const current = records.get(update.record.participant_id);
  // Updates can overtake each other only across a reconnect; never go back to an older one.
  if (current && current.expires_at > update.record.expires_at) return records;
  return new Map(records).set(update.record.participant_id, update.record);
}

/** The records still alive at `now`: nothing is sent when one expires, so drop it here. */
export function livePresence(records: PresenceMap, now: number): PresenceMap {
  let changed = false;
  const out = new Map<string, PresenceRecord>();
  for (const [id, record] of records) {
    if (Date.parse(record.expires_at) > now) out.set(id, record);
    else changed = true;
  }
  return changed ? out : records;
}

/** A stable colour for a participant. */
export function colorOf(participantId: string): number {
  let hash = 0;
  for (let i = 0; i < participantId.length; i++)
    hash = (hash * 31 + participantId.charCodeAt(i)) >>> 0;
  return hash % PRESENCE_COLORS;
}

export interface RemoteCursor {
  participant_id: string;
  name: string;
  color: number;
  line: number;
  column: number;
  selection?: { start_line: number; start_column: number; end_line: number; end_column: number };
}

/** Everyone else's cursor on `path`, in participant order. */
export function cursorsOn(
  records: PresenceMap,
  path: string,
  selfId: string,
  nameOf: (id: string) => string,
): RemoteCursor[] {
  const out: RemoteCursor[] = [];
  for (const record of [...records.values()].sort((a, b) =>
    a.participant_id < b.participant_id ? -1 : 1,
  )) {
    const cursor = record.cursor;
    if (record.participant_id === selfId || !cursor || cursor.path !== path) continue;
    out.push({
      participant_id: record.participant_id,
      name: nameOf(record.participant_id),
      color: colorOf(record.participant_id),
      line: cursor.line,
      column: cursor.column,
      ...(cursor.selection ? { selection: cursor.selection } : {}),
    });
  }
  return out;
}

/** Who else has each file open, for the tree. */
export function viewersByPath(records: PresenceMap, selfId: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const record of records.values()) {
    if (record.participant_id === selfId) continue;
    for (const path of record.open_files)
      out.set(path, [...(out.get(path) ?? []), record.participant_id]);
  }
  return out;
}

export type OwnPresence = Pick<PresenceRecord, "status" | "open_files" | "cursor">;

/**
 * Keeps this tab's record on the server: sends the latest value at most every
 * {@link MIN_INTERVAL_MS} (cursor moves in between are coalesced) and again every
 * {@link HEARTBEAT_MS} so it doesn't expire. A failed send (rate limited, offline) is tried
 * again after {@link RETRY_MS}.
 */
export class PresenceSender {
  private latest: OwnPresence | undefined;
  private lastSentAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(
    private readonly send: (value: OwnPresence) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  set(value: OwnPresence): void {
    if (this.stopped) return;
    this.latest = {
      ...value,
      open_files: value.open_files.slice(-MAX_OPEN_FILES),
      cursor:
        value.cursor && value.open_files.slice(-MAX_OPEN_FILES).includes(value.cursor.path)
          ? value.cursor
          : null,
    };
    this.heartbeat ??= setInterval(() => this.flush(), HEARTBEAT_MS);
    if (this.timer) return;
    const wait = Math.max(0, this.lastSentAt + MIN_INTERVAL_MS - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (!this.latest || this.stopped) return;
    this.lastSentAt = this.now();
    const sent = this.latest;
    this.send(sent).catch(() => {
      if (this.stopped || this.timer || this.latest !== sent) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, RETRY_MS);
    });
  }

  /** Send `last` (closing the editor: no files open) once, then stop; the record then expires. */
  stop(last?: OwnPresence): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    if (last && this.latest) this.send(last).catch(() => undefined);
    this.stopped = true;
  }
}
