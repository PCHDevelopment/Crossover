import { describe, expect, it } from "vitest";
import { scanSecrets, type SecretFinding } from "./secret-scanner.js";

/**
 * T901 fixtures. Each rule has a positive fixture and near-misses that must NOT
 * match. The matched value is kept here (test-only) so the "never echoed" tests
 * can assert it is absent from every finding.
 */
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const AWS_TEMP = "ASIA1234567890ABCDEF";
const GITHUB_TOKEN = `ghp_${"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9"}`; // ghp_ + 36
const GITHUB_SHORT = `ghp_${"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"}`; // ghp_ + 34
const PRIVATE_KEY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEpAIBAAKCAQEA7v5aQ7R6s9w0x1y2z3A4B5C6D7E8F9G0H1I2J3K4L5M6N7O8",
  "P9Q0R1S2T3U4V5W6X7Y8Z9A0B1C2D3E4F5G6H7I8J9K0L1M2N3O4P5Q6R7S8T9U0",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const PKCS8_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "MIG2AgMBAAKCBDk1234567890abcdefghijklmnopqrstuvwxyz0123456",
  "-----END PRIVATE KEY-----",
].join("\n");
const HIGH_ENTROPY = "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW"; // 32 chars, mixed

const rules = new Set([
  "aws_access_key_id",
  "github_token",
  "private_key_block",
  "high_entropy_assignment",
]);

/** Assert a finding set is exactly the given (rule, confidence) pairs, in order. */
const expectFindings = (
  text: string,
  expected: Array<Pick<SecretFinding, "rule" | "confidence">>,
): SecretFinding[] => {
  const findings = scanSecrets(text);
  expect(findings.map((f) => ({ rule: f.rule, confidence: f.confidence }))).toEqual(expected);
  return findings;
};

describe("secret scanner — AWS access keys", () => {
  it("matches long-term and temporary keys", () => {
    expectFindings(`key = ${AWS_KEY}`, [{ rule: "aws_access_key_id", confidence: "high" }]);
    expectFindings(`tmp = ${AWS_TEMP}`, [{ rule: "aws_access_key_id", confidence: "high" }]);
  });

  it("does not match near-misses", () => {
    expect(scanSecrets("key = AKIA123")).toEqual([]); // too short
    expect(scanSecrets("key = akiaiosfodnn7example")).toEqual([]); // lowercase
    expect(scanSecrets("key = AKIAIOSFODNN7EXAMPL")).toEqual([]); // 19 chars
    expect(scanSecrets("key = AKIA-IOSFODNN7EXAMPLE")).toEqual([]); // internal dash
  });
});

describe("secret scanner — GitHub tokens", () => {
  it("matches every gh* token prefix at length", () => {
    for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
      const token = `${prefix}${"x".repeat(36)}`;
      expectFindings(`t = ${token}`, [{ rule: "github_token", confidence: "high" }]);
    }
  });

  it("does not match near-misses", () => {
    expect(scanSecrets(`t = ${GITHUB_SHORT}`)).toEqual([]); // 34 chars, too short
    expect(scanSecrets("t = xhp_abcdefghijklmnopqrstuvwxyz0123456789")).toEqual([]); // wrong prefix
    expect(scanSecrets("t = ghp_")).toEqual([]); // no body
  });
});

describe("secret scanner — private key blocks", () => {
  it("matches PKCS#1 and PKCS#8 blocks", () => {
    expectFindings(PRIVATE_KEY, [{ rule: "private_key_block", confidence: "high" }]);
    expectFindings(PKCS8_KEY, [{ rule: "private_key_block", confidence: "high" }]);
  });

  it("does not match public keys or an unterminated block", () => {
    const public_ = [
      "-----BEGIN PUBLIC KEY-----",
      "MFwwDQYJKoZIhvcNAQEBBQADSwAwSAJBAKx",
      "-----END PUBLIC KEY-----",
    ].join("\n");
    expect(scanSecrets(public_)).toEqual([]);
    expect(scanSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA")).toEqual([]); // no END
  });
});

describe("secret scanner — high-entropy assignments", () => {
  it("matches a high-entropy value on a secret keyword", () => {
    expectFindings(`api_key = "${HIGH_ENTROPY}"`, [
      { rule: "high_entropy_assignment", confidence: "low" },
    ]);
    expectFindings(`token: ${HIGH_ENTROPY}`, [
      { rule: "high_entropy_assignment", confidence: "low" },
    ]);
  });

  it("does not match near-misses", () => {
    expect(scanSecrets('api_key = "short"')).toEqual([]); // value too short
    expect(scanSecrets('api_key = "aaaaaaaaaaaaaaaa"')).toEqual([]); // low entropy
    expect(scanSecrets(`name = "${HIGH_ENTROPY}"`)).toEqual([]); // keyword not in the list
    expect(scanSecrets("api_key = 12")).toEqual([]); // not an assignment of a long value
  });
});

describe("secret scanner — the matched value is never exposed", () => {
  const cases: Array<[string, string]> = [
    [`aws = ${AWS_KEY}`, AWS_KEY],
    [`gh = ${GITHUB_TOKEN}`, GITHUB_TOKEN],
    [PRIVATE_KEY, "MIIEpAIBAAKCAQEA7v5a"],
    [`api_key = "${HIGH_ENTROPY}"`, HIGH_ENTROPY],
  ];

  it.each(cases)("keeps %s out of every finding", (text, secret) => {
    const findings = scanSecrets(text);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      // The serialized finding is what a caller could log, emit, or store.
      expect(JSON.stringify(finding)).not.toContain(secret);
      // And the finding shape has no field that could carry it.
      expect(finding).not.toHaveProperty("value");
      expect(finding).not.toHaveProperty("match");
    }
  });

  it("fingerprint is a stable 16-hex prefix, independent of the value text", () => {
    const a = scanSecrets(`api_key = "${HIGH_ENTROPY}"`)[0]!;
    const b = scanSecrets(`api_key = "${HIGH_ENTROPY}"`)[0]!;
    const c = scanSecrets(`api_key = "${HIGH_ENTROPY}x"`)[0]!;
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(a.fingerprint).toBe(b.fingerprint); // deterministic
    expect(a.fingerprint).not.toBe(c.fingerprint); // value-sensitive
  });
});

describe("secret scanner — positions", () => {
  it("reports 1-based line and column of the match start", () => {
    // A GitHub token on line 3; "const t = " is 10 chars, so the token starts at col 11.
    const withToken = `line one\nline two\nconst t = ${GITHUB_TOKEN};`;
    const finding = scanSecrets(withToken)[0]!;
    expect(finding.line).toBe(3);
    expect(finding.col).toBe(11);
  });

  it("orders findings by line then column", () => {
    const text = [`a = ${AWS_KEY}`, `b = ${GITHUB_TOKEN}`].join("\n");
    const findings = scanSecrets(text);
    expect(findings.map((f) => f.line)).toEqual([1, 2]);
  });
});

describe("secret scanner — overlap suppression", () => {
  it("reports a GitHub token assigned to a variable once, as a GitHub token", () => {
    const text = `token = "${GITHUB_TOKEN}"`;
    const findings = scanSecrets(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("github_token");
    expect(findings[0]!.confidence).toBe("high");
  });

  it("does not double-report a specific rule's span under the generic rule", () => {
    const text = `access_key = ${AWS_KEY}`;
    const findings = scanSecrets(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe("aws_access_key_id");
  });
});

describe("secret scanner — total and pure", () => {
  it("returns [] for empty input and never throws on odd input", () => {
    expect(scanSecrets("")).toEqual([]);
    expect(scanSecrets("\u0000\u0001\u0002")).toEqual([]);
    expect(scanSecrets("no secrets here at all")).toEqual([]);
    // A huge run of one character must not blow up the entropy math.
    expect(scanSecrets(`api_key = "${"a".repeat(1000)}"`)).toEqual([]);
  });

  it("only ever emits known rules", () => {
    const blob = `${AWS_KEY} ${GITHUB_TOKEN} ${PRIVATE_KEY} api_key = "${HIGH_ENTROPY}"`;
    for (const finding of scanSecrets(blob)) expect(rules.has(finding.rule)).toBe(true);
  });
});
