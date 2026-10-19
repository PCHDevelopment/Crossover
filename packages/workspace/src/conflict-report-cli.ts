import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createPool } from "@crossover/db";
import { z } from "zod";
import {
  conflictRateReport,
  type ConflictRateReport,
  type ParticipantKind,
} from "./conflict-metrics.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const date = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO date");
const argsSchema = z.object({
  since: date.optional(),
  until: date.optional(),
  room: z.array(z.string().min(1)).optional(),
  format: z.enum(["json", "md"]).default("md"),
});

const KINDS: readonly ParticipantKind[] = ["HUMAN", "AGENT", "SYSTEM"];
const percent = (rate: number | null) => (rate === null ? "-" : `${(rate * 100).toFixed(1)}%`);

/** The three tables of the markdown report, then the structured-merge candidate line. */
export function markdown(report: ConflictRateReport): string {
  const lines = [
    `# Conflict-rate report, ${report.since} to ${report.until} (${report.rooms} rooms)`,
    "",
    "## By participant kind",
    "",
    "| kind | submissions | contended | conflicted | conflict rate |",
    "|---|---|---|---|---|",
    ...KINDS.map((kind) => {
      const cell = report.by_participant[kind];
      return `| ${kind} | ${cell.submissions} | ${cell.contended} | ${cell.conflicted} | ${percent(cell.conflict_rate)} |`;
    }),
    "",
    "## By file extension (top 20 by conflicted files)",
    "",
    "| extension | kind | contended touches | conflicted files |",
    "|---|---|---|---|",
  ];
  const rows = Object.entries(report.by_extension).flatMap(([ext, cells]) =>
    KINDS.filter(
      (kind) => cells[kind].contended_file_touches + cells[kind].conflicted_files > 0,
    ).map((kind) => ({ ext, kind, ...cells[kind] })),
  );
  rows.sort(
    (a, b) =>
      b.conflicted_files - a.conflicted_files ||
      a.ext.localeCompare(b.ext) ||
      a.kind.localeCompare(b.kind),
  );
  for (const row of rows.slice(0, 20))
    lines.push(
      `| ${row.ext} | ${row.kind} | ${row.contended_file_touches} | ${row.conflicted_files} |`,
    );
  lines.push("", "## Conflicted ChangeSets by submitter -> counterparty", "");
  lines.push("| submitter | HUMAN | AGENT | SYSTEM |", "|---|---|---|---|");
  for (const from of KINDS)
    lines.push(`| ${from} | ${KINDS.map((to) => report.by_pair[`${from}->${to}`]).join(" | ")} |`);
  lines.push(
    "",
    `Structured-merge candidates (CONTENT conflicts in supported languages): HUMAN ${report.structured_candidates.HUMAN}, AGENT ${report.structured_candidates.AGENT}`,
    "",
  );
  return lines.join("\n");
}

/** Run the report; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  let args: z.infer<typeof argsSchema>;
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        since: { type: "string" },
        until: { type: "string" },
        room: { type: "string", multiple: true },
        format: { type: "string" },
      },
    });
    args = argsSchema.parse(values);
  } catch (error) {
    process.stderr.write(`conflict-report: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
  const until = args.until ? new Date(args.until) : new Date();
  const since = args.since ? new Date(args.since) : new Date(until.getTime() - 28 * DAY_MS);
  const pool = createPool();
  try {
    const report = await conflictRateReport(pool, {
      since,
      until,
      ...(args.room ? { roomIds: args.room } : {}),
    });
    process.stdout.write(
      args.format === "json" ? `${JSON.stringify(report, null, 2)}\n` : markdown(report),
    );
    return 0;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main(process.argv.slice(2)).then((code) => process.exit(code));
