import type { Pool } from "@crossover/db";
import type { ConflictKind } from "./conflicts.js";
import type { StructuredMergeRefusalRecord } from "./merge-drivers.js";

export interface ConflictRateOptions {
  since: Date;
  until: Date;
  roomIds?: string[];
}

export type ParticipantKind = "HUMAN" | "AGENT" | "SYSTEM";

export interface RateCell {
  /** ChangeSets with status APPLIED or CONFLICT. */
  submissions: number;
  /** Of those, a real merge ran (the base was not the head at apply time). */
  contended: number;
  conflicted: number;
  /** conflicted / contended, 4 decimals; null if contended = 0. */
  conflict_rate: number | null;
  /** Conflicted files by kind. */
  by_kind: Record<ConflictKind, number>;
}

interface ExtensionCell {
  contended_file_touches: number;
  conflicted_files: number;
  by_kind: Record<ConflictKind, number>;
}

/** What structured merge did with the contended ChangeSets (T1592, §25.1). */
export interface StructuredOutcomes {
  /** APPLIED ChangeSets with at least one file resolved by a driver. */
  resolved_changesets: Record<ParticipantKind, number>;
  /** Extension -> driver -> files a driver resolved. */
  resolved_files: Record<string, Record<string, number>>;
  /** Refused files of CONFLICT ChangeSets: kind -> reason -> count. */
  refusals: Record<ParticipantKind, Record<string, number>>;
  refusals_by_extension: Record<string, Record<string, number>>;
  /** resolved / (resolved + conflicted), 4 decimals; null if both are 0. */
  saved_rate: Record<ParticipantKind, number | null>;
  /** Stored values or entries that were not in the recorded shape, skipped. */
  malformed: number;
}

export interface ConflictRateReport {
  report_version: 2;
  since: string;
  until: string;
  rooms: number;
  /** Ledger cross-check. */
  events: { applied: number; conflict_created: number };
  by_participant: Record<ParticipantKind, RateCell>;
  by_extension: Record<string, Record<ParticipantKind, ExtensionCell>>;
  /** Submitter kind -> counterparty kind, conflicted ChangeSets. */
  by_pair: Record<`${ParticipantKind}->${ParticipantKind}`, number>;
  /** CONTENT conflicts in languages structured merge could handle. */
  structured_candidates: { HUMAN: number; AGENT: number };
  structured: StructuredOutcomes;
}

const KINDS: readonly ParticipantKind[] = ["HUMAN", "AGENT", "SYSTEM"];
const CONFLICT_KINDS: readonly ConflictKind[] = [
  "CONTENT",
  "MODIFY_DELETE",
  "RENAME",
  "ADD_ADD",
  "BINARY",
  "PARSE",
];
const STRUCTURED_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
  "py",
  "json",
]);

// The only strings a driver or reason may put in the report: stored text is bucketed as "other".
const KNOWN_DRIVERS: ReadonlySet<string> = new Set([
  "typescript-toplevel",
  "python-toplevel",
  "json-keys",
]);
const REFUSAL_REASONS: Record<StructuredMergeRefusalRecord["reason"], true> = {
  parse_error: true,
  same_key: true,
  add_add: true,
  delete_modify: true,
  duplicate_key: true,
  unkeyed_change: true,
  reorder: true,
  trailer: true,
  result_parse_error: true,
  verify_mismatch: true,
  not_canonical: true,
  unsupported: true,
  too_large: true,
  driver_error: true,
  ineligible: true,
  no_driver: true,
  budget: true,
  not_utf8: true,
};
const known = (value: unknown, set: ReadonlySet<string>): string =>
  typeof value === "string" && set.has(value) ? value : "other";
const KNOWN_REASONS: ReadonlySet<string> = new Set(Object.keys(REFUSAL_REASONS));
const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** The well-formed entries of a stored array (an absent value is none), and how many were not. */
function storedEntries(
  value: unknown,
  valid: (entry: Record<string, unknown>) => boolean,
): { entries: Record<string, unknown>[]; malformed: number } {
  if (value === undefined || value === null) return { entries: [], malformed: 0 };
  if (!Array.isArray(value)) return { entries: [], malformed: 1 };
  const entries: Record<string, unknown>[] = [];
  for (const entry of value as unknown[])
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry))
      if (valid(entry as Record<string, unknown>)) entries.push(entry as Record<string, unknown>);
  return { entries, malformed: value.length - entries.length };
}

const kindCounts = (): Record<ConflictKind, number> =>
  Object.fromEntries(CONFLICT_KINDS.map((kind) => [kind, 0])) as Record<ConflictKind, number>;
const rateCell = (): RateCell => ({
  submissions: 0,
  contended: 0,
  conflicted: 0,
  conflict_rate: null,
  by_kind: kindCounts(),
});
const extensionCell = (): ExtensionCell => ({
  contended_file_touches: 0,
  conflicted_files: 0,
  by_kind: kindCounts(),
});

/**
 * The lower-cased text after the last dot of the basename; "(none)" or "(dotfile)" otherwise.
 * It is a key of a report that is logged, and a path is user text, so anything that is not a short
 * run of letters and digits (a name that could carry content or a secret) is "(other)".
 */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot === -1 || dot === base.length - 1) return "(none)";
  if (dot === 0) return "(dotfile)";
  const extension = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(extension) ? extension : "(other)";
}

interface Row {
  id: string;
  status: "APPLIED" | "CONFLICT";
  base_workspace_revision: string;
  applied_revision: string | null;
  payload: {
    operations?: { path?: string; from?: string; to?: string }[];
    conflicts?: { path?: string; kind?: ConflictKind }[];
    counterparty_changesets?: string[];
    structured_merges?: unknown;
    structured_merge_refusals?: unknown;
  };
  kind: ParticipantKind;
}

const KIND_SQL = "COALESCE(p.kind, 'SYSTEM')";
// Only what the report reads: a payload also holds every file's content, which can be megabytes.
const PAYLOAD_SQL = `jsonb_build_object(
  'operations', COALESCE((SELECT jsonb_agg(jsonb_build_object('path', o->'path', 'from', o->'from', 'to', o->'to'))
                            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'operations') = 'array'
                                                           THEN c.payload->'operations' ELSE '[]'::jsonb END) o), '[]'::jsonb),
  'conflicts', COALESCE((SELECT jsonb_agg(jsonb_build_object('path', f->'path', 'kind', f->'kind'))
                           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.payload->'conflicts') = 'array'
                                                          THEN c.payload->'conflicts' ELSE '[]'::jsonb END) f), '[]'::jsonb),
  'counterparty_changesets', COALESCE(c.payload->'counterparty_changesets', '[]'::jsonb),
  'structured_merges', c.payload->'structured_merges',
  'structured_merge_refusals', c.payload->'structured_merge_refusals')`;

/**
 * Conflict rates by participant kind and file extension over `[since, until)` (T1586). Read-only
 * and counts only: the report holds no paths, room ids, participant ids or content (§2.9, §23).
 * Every statement is scoped to one room; the per-room results are added up here.
 */
export async function conflictRateReport(
  pool: Pick<Pool, "query">,
  options: ConflictRateOptions,
): Promise<ConflictRateReport> {
  const roomIds =
    options.roomIds ??
    (await pool.query<{ id: string }>("SELECT id FROM rooms ORDER BY id")).rows.map((r) => r.id);
  const report: ConflictRateReport = {
    report_version: 2,
    since: options.since.toISOString(),
    until: options.until.toISOString(),
    rooms: roomIds.length,
    events: { applied: 0, conflict_created: 0 },
    by_participant: { HUMAN: rateCell(), AGENT: rateCell(), SYSTEM: rateCell() },
    by_extension: {},
    by_pair: Object.fromEntries(
      KINDS.flatMap((from) => KINDS.map((to) => [`${from}->${to}`, 0])),
    ) as ConflictRateReport["by_pair"],
    structured_candidates: { HUMAN: 0, AGENT: 0 },
    structured: {
      resolved_changesets: { HUMAN: 0, AGENT: 0, SYSTEM: 0 },
      resolved_files: {},
      refusals: { HUMAN: {}, AGENT: {}, SYSTEM: {} },
      refusals_by_extension: {},
      saved_rate: { HUMAN: null, AGENT: null, SYSTEM: null },
      malformed: 0,
    },
  };
  const extension = (ext: string, kind: ParticipantKind): ExtensionCell => {
    report.by_extension[ext] ??= {
      HUMAN: extensionCell(),
      AGENT: extensionCell(),
      SYSTEM: extensionCell(),
    };
    return report.by_extension[ext]![kind];
  };

  for (const roomId of roomIds) {
    const { rows } = await pool.query<Row>(
      `SELECT c.id, c.status, c.base_workspace_revision, c.applied_revision,
              ${PAYLOAD_SQL} AS payload, ${KIND_SQL} AS kind
         FROM changesets c
         LEFT JOIN participants p ON p.id = c.actor_id AND p.room_id = c.room_id
        WHERE c.room_id = $1 AND c.created_at >= $2 AND c.created_at < $3
          AND c.source <> 'UPSTREAM' AND c.status IN ('APPLIED', 'CONFLICT')`,
      [roomId, options.since, options.until],
    );
    const counterpartyIds = [
      ...new Set(rows.flatMap((row) => row.payload.counterparty_changesets ?? [])),
    ];
    const counterpartyKinds = new Map<string, ParticipantKind>();
    if (counterpartyIds.length > 0) {
      const found = await pool.query<{ id: string; kind: ParticipantKind }>(
        `SELECT c.id, ${KIND_SQL} AS kind
           FROM changesets c
           LEFT JOIN participants p ON p.id = c.actor_id AND p.room_id = c.room_id
          WHERE c.room_id = $1 AND c.id = ANY($2::text[])`,
        [roomId, counterpartyIds],
      );
      for (const row of found.rows) counterpartyKinds.set(row.id, row.kind);
    }

    for (const row of rows) {
      const cell = report.by_participant[row.kind];
      cell.submissions++;
      const conflicted = row.status === "CONFLICT";
      // Stored history is never trusted: only fixed strings reach the report, the rest is "other".
      const structured = report.structured;
      if (!conflicted) {
        const merged = storedEntries(
          row.payload.structured_merges,
          (entry) => typeof entry["path"] === "string" && typeof entry["driver"] === "string",
        );
        structured.malformed += merged.malformed;
        if (merged.entries.length > 0) structured.resolved_changesets[row.kind]++;
        for (const entry of merged.entries) {
          const ext = extensionOf(entry["path"] as string);
          structured.resolved_files[ext] ??= {};
          bump(structured.resolved_files[ext]!, known(entry["driver"], KNOWN_DRIVERS));
        }
      } else {
        const refused = storedEntries(
          row.payload.structured_merge_refusals,
          (entry) =>
            typeof entry["path"] === "string" &&
            (typeof entry["driver"] === "string" || entry["driver"] === null) &&
            typeof entry["reason"] === "string",
        );
        structured.malformed += refused.malformed;
        for (const entry of refused.entries) {
          const reason = known(entry["reason"], KNOWN_REASONS);
          const ext = extensionOf(entry["path"] as string);
          bump(structured.refusals[row.kind], reason);
          structured.refusals_by_extension[ext] ??= {};
          bump(structured.refusals_by_extension[ext]!, reason);
        }
      }
      // A fast-forward (applied = base + 1) ran no merge, so it was not contended.
      const contended =
        conflicted ||
        (row.applied_revision !== null &&
          Number(row.applied_revision) > Number(row.base_workspace_revision) + 1);
      if (!contended) continue;
      cell.contended++;
      for (const operation of row.payload.operations ?? []) {
        for (const path of [operation.path, operation.from, operation.to])
          if (path) extension(extensionOf(path), row.kind).contended_file_touches++;
      }
      if (!conflicted) continue;
      cell.conflicted++;
      // The ChangeSet's own classification: a later resolution attempt overwrites the conflict row.
      for (const file of row.payload.conflicts ?? []) {
        if (!file.path || !file.kind) continue;
        const ext = extensionOf(file.path);
        const ecell = extension(ext, row.kind);
        ecell.conflicted_files++;
        ecell.by_kind[file.kind]++;
        cell.by_kind[file.kind]++;
        if (file.kind === "CONTENT" && STRUCTURED_EXTENSIONS.has(ext) && row.kind !== "SYSTEM")
          report.structured_candidates[row.kind]++;
      }
      const pairs = new Set<ParticipantKind>(
        (row.payload.counterparty_changesets ?? []).map(
          (id) => counterpartyKinds.get(id) ?? "SYSTEM",
        ),
      );
      if (pairs.size === 0) pairs.add("SYSTEM");
      for (const other of pairs) report.by_pair[`${row.kind}->${other}`]++;
    }

    const counted = await pool.query<{ type: string; n: string }>(
      `SELECT type, count(*) AS n FROM events
        WHERE room_id = $1 AND timestamp >= $2 AND timestamp < $3
          AND type IN ('workspace.changeset.applied', 'workspace.conflict.created')
        GROUP BY type`,
      [roomId, options.since, options.until],
    );
    for (const row of counted.rows) {
      if (row.type === "workspace.changeset.applied") report.events.applied += Number(row.n);
      else report.events.conflict_created += Number(row.n);
    }
  }

  for (const kind of KINDS) {
    const saved = report.structured.resolved_changesets[kind];
    const total = saved + report.by_participant[kind].conflicted;
    report.structured.saved_rate[kind] =
      total === 0 ? null : Math.round((saved / total) * 10_000) / 10_000;
  }
  for (const cell of Object.values(report.by_participant))
    cell.conflict_rate =
      cell.contended === 0
        ? null
        : Math.round((cell.conflicted / cell.contended) * 10_000) / 10_000;
  return report;
}
