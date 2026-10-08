import { describe, expect, it } from "vitest";
import {
  ENTROPY_THRESHOLD,
  MAX_FINDINGS_PER_FILE,
  MAX_SCAN_BYTES,
  scanSecrets,
  type SecretFinding,
} from "./secret-scanner.js";

// A realistic AWS key that is NOT a documented example (the docs key
// AKIAIOSFODNN7EXAMPLE is allowlisted and must not match).
const AWS_KEY = "AKIA1234567890ABCDEF";
const GITHUB_TOKEN = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const HIGH_ENTROPY = "aB3dE5gH7jK9mN1pQ2rS4tU6vW8xY0z";

describe("security.scanSecrets", () => {
  it("flags an AWS access key ID", () => {
    const findings = scanSecrets(`awsKey = "${AWS_KEY}"`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("aws_access_key_id");
    expect(findings[0]!.confidence).toBe("high");
  });

  it("flags a GitHub personal access token", () => {
    const findings = scanSecrets(`token: "${GITHUB_TOKEN}"`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("github_token");
    expect(findings[0]!.confidence).toBe("high");
  });

  it("flags a private key block", () => {
    const text = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA7v5aUzmCoE0s2h9s",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const findings = scanSecrets(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("private_key_block");
    expect(findings[0]!.confidence).toBe("high");
  });

  it("flags a high-entropy assignment", () => {
    const findings = scanSecrets(`secret: "${HIGH_ENTROPY}"`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("high_entropy_assignment");
    expect(findings[0]!.confidence).toBe("low");
  });

  it("flags .env-style names with a prefix before the keyword", () => {
    const text = [
      "DB_PASSWORD=x9y8z7w6v5u4t3s2r1q0p8o7m6n5",
      "GITHUB_TOKEN=" + GITHUB_TOKEN,
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCyReal1",
      "stripe_api_key=sk_live_4eC39HvLyjStYvTq8z",
    ].join("\n");
    const findings = scanSecrets(text);
    const rules = findings.map((f) => f.rule).sort();
    // GITHUB_TOKEN is caught by the specific GitHub rule; the other three by the
    // generic assignment rule.
    expect(rules).toContain("github_token");
    expect(rules.filter((r) => r === "high_entropy_assignment")).toHaveLength(3);
  });

  it("does not flag a low-entropy assignment", () => {
    expect(scanSecrets(`password = "hunter2"`)).toHaveLength(0);
  });

  it("does not flag a short token", () => {
    expect(scanSecrets(`token = "short"`)).toHaveLength(0);
  });

  it("does not flag a call or a bare identifier as a value", () => {
    const text = ["token = createSandboxReadToken()", "password = myPasswordValueHere"].join("\n");
    expect(scanSecrets(text)).toHaveLength(0);
  });

  it("ignores documented example values (allowlist)", () => {
    // The AWS docs example key and anything ending in EXAMPLE are not secrets.
    expect(scanSecrets(`awsKey = "AKIAIOSFODNN7EXAMPLE"`)).toHaveLength(0);
    expect(scanSecrets(`token = "someValueEndingInEXAMPLE"`)).toHaveLength(0);
  });

  it("reports the line and column of the match", () => {
    const text = `first line\nawsKey = "${AWS_KEY}"\nthird line`;
    const findings = scanSecrets(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(2);
    expect(findings[0]!.col).toBe(11); // 1-based column of the key
  });

  it("never includes the matched value in a finding", () => {
    const findings = scanSecrets(`awsKey = "${AWS_KEY}"`);
    expect(findings).toHaveLength(1);
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain(AWS_KEY);
    expect(Object.keys(findings[0]!)).toEqual(
      expect.arrayContaining(["rule", "confidence", "line", "col", "fingerprint"]),
    );
  });

  it("dedupes a value matched by two rules", () => {
    const findings = scanSecrets(`token = "${GITHUB_TOKEN}"`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("github_token");
  });

  it("returns findings in source order", () => {
    const text = `a = "${AWS_KEY}"\nb = "${GITHUB_TOKEN}"`;
    const findings = scanSecrets(text);
    expect(findings.map((f) => f.line)).toEqual([1, 2]);
  });

  it("is stable: the same input yields the same fingerprint", () => {
    const a = scanSecrets(`k = "${AWS_KEY}"`);
    const b = scanSecrets(`k = "${AWS_KEY}"`);
    expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
    expect(a[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("only reports findings on added lines when addedLines is set", () => {
    const text = `line one\n${AWS_KEY}\nline three`;
    // The key is on line 2; if only line 3 is added, it is not reported.
    expect(scanSecrets(text, { addedLines: new Set([3]) })).toHaveLength(0);
    // If line 2 is added, it is reported at line 2.
    const findings = scanSecrets(text, { addedLines: new Set([2]) });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(2);
  });

  it("reports a file larger than the scan cap as scan_skipped", () => {
    const text = "x".repeat(MAX_SCAN_BYTES + 1);
    const findings = scanSecrets(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("scan_skipped");
    expect(findings[0]!.confidence).toBe("low");
  });

  it("caps findings at the per-file maximum", () => {
    const line = `k = ${AWS_KEY}\n`;
    const text = line.repeat(MAX_FINDINGS_PER_FILE + 5);
    const findings = scanSecrets(text);
    expect(findings.length).toBeLessThanOrEqual(MAX_FINDINGS_PER_FILE);
  });

  it("scans a 1 MB adversarial input within a time bound", () => {
    // ~50k AWS keys. The old scanner's position() rescan made this O(n^2)
    // (108 s); the line-start table + cap keep it well under a second.
    const line = `key = ${AWS_KEY}\n`;
    const text = line.repeat(Math.ceil((1024 * 1024) / line.length));
    const start = Date.now();
    const findings = scanSecrets(text);
    const ms = Date.now() - start;
    expect(ms).toBeLessThan(2000);
    expect(findings.length).toBeLessThanOrEqual(MAX_FINDINGS_PER_FILE);
  });

  it("is total: it never throws", () => {
    for (const text of [
      "",
      "plain text",
      "-----BEGIN RSA PRIVATE KEY-----", // unterminated
      "🎉 emoji and unicode — 日本語",
      "a".repeat(10_000),
      `token = "${"x".repeat(200)}"`, // value longer than the 128 cap
    ]) {
      expect(() => scanSecrets(text)).not.toThrow();
    }
  });

  it("handles an empty string", () => {
    expect(scanSecrets("")).toEqual([]);
  });

  it("exposes the entropy threshold", () => {
    expect(ENTROPY_THRESHOLD).toBeGreaterThan(0);
  });

  it("finding shape is stable for dedupe", () => {
    const f: SecretFinding = {
      rule: "aws_access_key_id",
      confidence: "high",
      line: 1,
      col: 1,
      fingerprint: "0123456789abcdef",
    };
    expect(f.fingerprint).toHaveLength(16);
  });
});
