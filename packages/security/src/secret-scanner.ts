import { createHash } from "node:crypto";

/**
 * Secret scanner (§23.3, T901). A gitleaks-compatible rule subset: AWS keys,
 * GitHub tokens, private key blocks and generic high-entropy assignments.
 *
 * The scanner is pure and total: it never throws on input, and a finding never
 * carries the matched value — only its rule, confidence, position and a short
 * sha256 fingerprint of the match. Callers must not echo the plaintext in
 * errors, events or inbox items; the tests assert that.
 *
 * It is also bounded: line positions come from a precomputed line-start table
 * (binary search, not a rescan), a private-key block must find its END within
 * 16 KiB, a file larger than 2 MiB is reported as a low-confidence
 * `scan_skipped` finding rather than scanned, and at most 20 findings are
 * reported per file. These bounds keep attacker-controlled input from turning
 * the scan into a CPU DoS.
 */

export type SecretRule =
  | "aws_access_key_id"
  | "github_token"
  | "private_key_block"
  | "high_entropy_assignment"
  | "scan_skipped";

export type SecretConfidence = "high" | "low";

export interface SecretFinding {
  rule: SecretRule;
  confidence: SecretConfidence;
  /** 1-based line of the match's first character. */
  line: number;
  /** 1-based column of the match's first character (UTF-16 units). */
  col: number;
  /** First 16 hex chars of sha256 over the matched text. Stable for dedupe, not a secret. */
  fingerprint: string;
}

export interface ScanOptions {
  /** Display path for the caller; never part of a fingerprint. */
  path?: string;
  /**
   * When set, only findings whose line is in this set are reported. Used to
   * scan only the lines a ChangeSet adds, so a pre-existing secret does not
   * wedge an unrelated edit.
   */
  addedLines?: Set<number>;
}

/**
 * Shannon-entropy floor (bits/char) for the generic assignment rule. Gitleaks
 * defaults to 3.0; 3.5 trades a few true positives for fewer false alarms on
 * low-entropy values that merely look like assignments.
 */
export const ENTROPY_THRESHOLD = 3.5;

/** A file larger than this is reported as `scan_skipped` instead of scanned. */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/** A private-key block must find its END within this many bytes of its BEGIN. */
const KEY_BLOCK_MAX = 16 * 1024;

/** At most this many findings are reported per file. */
export const MAX_FINDINGS_PER_FILE = 20;

// `d` (hasIndices) reports each group's [start, end] so a captured value is
// located exactly, independent of any surrounding quotes.
const AWS_ACCESS_KEY = /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/dg;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/dg;
// The body is bounded to KEY_BLOCK_MAX so an unterminated BEGIN cannot scan to
// the end of a large file.
const PRIVATE_KEY = new RegExp(
  `-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\\s\\S]{0,${KEY_BLOCK_MAX}}?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`,
  "dg",
);
// The keyword may be preceded by identifier characters (gitleaks-style), so
// `.env`-style names like DB_PASSWORD, GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY and
// stripe_api_key are matched, not just bare `token`/`password`. The prefix is
// bounded to 32 chars: an unbounded `[A-Za-z0-9_.-]*` backtracks once per
// character per start position, which is quadratic on a long identifier run.
const ASSIGNMENT =
  /[A-Za-z0-9_.-]{0,32}(?:api[_-]?key|apikey|secret|access[_-]?key|token|password|passwd|auth[_-]?token|client[_-]?secret|private[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9+/_-]{16,128})["']?/dgi;

// Documented example values are not secrets: the AWS docs key and anything
// ending in EXAMPLE.
const ALLOWLIST = /example$/i;

export const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/** Offsets of the first character of each line, for O(log n) position lookups. */
const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
};

/** 1-based line and column of `index`, from a precomputed line-start table. */
const lineAndCol = (starts: number[], index: number): { line: number; col: number } => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: index - (starts[lo] ?? 0) + 1 };
};

/** Shannon entropy in bits per character. */
const entropy = (value: string): number => {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
};

/** The [start, end) span a match occupies, from its `d`-flag indices. */
const span = (match: RegExpMatchArray): [number, number] | null => {
  const i = match.indices?.[0];
  return i ? [i[0], i[1]] : null;
};

/**
 * Scan one text value. Returns findings in source order; a span already claimed
 * by a specific rule is not re-reported by the generic entropy rule, so a GitHub
 * token assigned to a `token` variable is reported once, as a GitHub token.
 */
export function scanSecrets(text: string, options: ScanOptions = {}): SecretFinding[] {
  if (text.length === 0) return [];
  // A file too large to scan is reported, not silently dropped.
  if (text.length > MAX_SCAN_BYTES) {
    return [
      {
        rule: "scan_skipped",
        confidence: "low",
        line: 1,
        col: 1,
        fingerprint: fingerprint(`skipped:${text.length}`),
      },
    ];
  }

  const starts = lineStarts(text);
  const findings: SecretFinding[] = [];
  const claimed: Array<[number, number]> = [];
  // `claimed` is bounded by MAX_FINDINGS_PER_FILE, so this stays cheap.
  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  const take = (
    rule: SecretRule,
    confidence: SecretConfidence,
    start: number,
    end: number,
    value: string,
  ): void => {
    if (start >= end || overlaps(start, end)) return;
    if (ALLOWLIST.test(value)) return;
    const { line, col } = lineAndCol(starts, start);
    if (options.addedLines && !options.addedLines.has(line)) return;
    claimed.push([start, end]);
    findings.push({ rule, confidence, line, col, fingerprint: fingerprint(value) });
  };

  for (const match of text.matchAll(GITHUB_TOKEN)) {
    if (findings.length >= MAX_FINDINGS_PER_FILE) break;
    const s = span(match);
    if (s) take("github_token", "high", s[0], s[1], match[0]);
  }
  for (const match of text.matchAll(AWS_ACCESS_KEY)) {
    if (findings.length >= MAX_FINDINGS_PER_FILE) break;
    const s = span(match);
    if (s) take("aws_access_key_id", "high", s[0], s[1], match[0]);
  }
  for (const match of text.matchAll(PRIVATE_KEY)) {
    if (findings.length >= MAX_FINDINGS_PER_FILE) break;
    const s = span(match);
    if (s) take("private_key_block", "high", s[0], s[1], match[0]);
  }
  for (const match of text.matchAll(ASSIGNMENT)) {
    if (findings.length >= MAX_FINDINGS_PER_FILE) break;
    const value = match[1];
    const valueIndices = match.indices?.[1];
    if (!value || !valueIndices) continue;
    const [valueStart, valueEnd] = valueIndices;
    if (overlaps(valueStart, valueEnd)) continue;
    // A call (`token = foo(`) or a bare identifier (`token = someConstant`) is
    // not a secret value.
    if (text[valueEnd] === "(") continue;
    if (/^[A-Za-z]+$/.test(value)) continue;
    // High entropy with no specific rule above: a probable, not certain, secret.
    if (entropy(value) >= ENTROPY_THRESHOLD)
      take("high_entropy_assignment", "low", valueStart, valueEnd, value);
  }

  return findings.sort((a, b) => a.line - b.line || a.col - b.col || a.rule.localeCompare(b.rule));
}
