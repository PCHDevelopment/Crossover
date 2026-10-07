import { createHash } from "node:crypto";

/**
 * Secret scanner (§23.3, T901). A gitleaks-compatible rule subset: AWS keys,
 * GitHub tokens, private key blocks and generic high-entropy assignments.
 *
 * The scanner is pure and total: it never throws on input, and a finding never
 * carries the matched value — only its rule, confidence, position and a short
 * sha256 fingerprint of the match. Callers must not echo the plaintext in
 * errors, events or inbox items; the tests assert that.
 */

export type SecretRule =
  "aws_access_key_id" | "github_token" | "private_key_block" | "high_entropy_assignment";

export type SecretConfidence = "high" | "low";

export interface SecretFinding {
  rule: SecretRule;
  confidence: SecretConfidence;
  /** 1-based line of the match's first character. */
  line: number;
  /** 1-based column of the match's first character. */
  col: number;
  /** First 16 hex chars of sha256 over the matched text. Stable for dedupe, not a secret. */
  fingerprint: string;
}

export interface ScanOptions {
  /** Display path for the caller; never part of a fingerprint. */
  path?: string;
}

/**
 * Shannon-entropy floor (bits/char) for the generic assignment rule. Gitleaks
 * defaults to 3.0; 3.5 trades a few true positives for fewer false alarms on
 * low-entropy values that merely look like assignments.
 */
export const ENTROPY_THRESHOLD = 3.5;

// `d` (hasIndices) reports each group's [start, end] so a captured value is
// located exactly, independent of any surrounding quotes.
const AWS_ACCESS_KEY = /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/dg;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/dg;
const PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/dg;
const ASSIGNMENT =
  /\b(?:api[_-]?key|apikey|secret|access[_-]?key|token|password|passwd|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?([A-Za-z0-9+/_-]{16,128})["']?/dgi;

const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const position = (text: string, index: number): { line: number; col: number } => {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line += 1;
  const lastNewline = text.lastIndexOf("\n", index - 1);
  return { line, col: index - lastNewline };
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
export function scanSecrets(text: string, _options: ScanOptions = {}): SecretFinding[] {
  if (text.length === 0) return [];
  const findings: SecretFinding[] = [];
  const claimed: Array<[number, number]> = [];
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
    claimed.push([start, end]);
    const { line, col } = position(text, start);
    findings.push({ rule, confidence, line, col, fingerprint: fingerprint(value) });
  };

  for (const match of text.matchAll(GITHUB_TOKEN)) {
    const s = span(match);
    if (s) take("github_token", "high", s[0], s[1], match[0]);
  }
  for (const match of text.matchAll(AWS_ACCESS_KEY)) {
    const s = span(match);
    if (s) take("aws_access_key_id", "high", s[0], s[1], match[0]);
  }
  for (const match of text.matchAll(PRIVATE_KEY)) {
    const s = span(match);
    if (s) take("private_key_block", "high", s[0], s[1], match[0]);
  }
  for (const match of text.matchAll(ASSIGNMENT)) {
    const value = match[1];
    const valueIndices = match.indices?.[1];
    if (!value || !valueIndices) continue;
    const [valueStart, valueEnd] = valueIndices;
    if (overlaps(valueStart, valueEnd)) continue;
    // High entropy with no specific rule above: a probable, not certain, secret.
    if (entropy(value) >= ENTROPY_THRESHOLD)
      take("high_entropy_assignment", "low", valueStart, valueEnd, value);
  }

  return findings.sort((a, b) => a.line - b.line || a.col - b.col || a.rule.localeCompare(b.rule));
}
