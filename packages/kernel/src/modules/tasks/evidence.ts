import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";

/** The most evidence one submission may carry, as JSON (§34.3). */
export const MAX_EVIDENCE_BYTES = 32 * 1024;

const proof = z.strictObject({
  /** What kind of proof: a test that ran, a check (lint, typecheck, CI), or a manual step. */
  kind: z.enum(["test", "check", "manual"]),
  /** Where to look: a test name, a CI run, a file, a description of the step. */
  ref: z.string().trim().min(1).max(500),
  note: z.string().max(1000).optional(),
});

const sabotage = z.strictObject({
  /** What was broken on purpose… */
  broke: z.string().trim().min(1).max(500),
  /** …and what failed because of it. */
  failed: z.string().trim().min(1).max(500),
});

const item = z.strictObject({
  /** Index into the task's `requirements`. */
  requirement: z.number().int().min(0),
  proof: z.array(proof).min(1).max(10),
  sabotage: z.array(sabotage).max(10).optional(),
});

export const evidenceSchema = z.array(item).max(100);
export type EvidenceItem = z.infer<typeof item>;

/**
 * Check `evidence` against the task's requirements: each requirement index must exist and
 * appear at most once, and the whole must fit in {@link MAX_EVIDENCE_BYTES}. `VALIDATION`
 * names what is wrong.
 */
export function validateEvidence(evidence: EvidenceItem[], requirementCount: number): void {
  const seen = new Set<number>();
  for (const e of evidence) {
    if (e.requirement >= requirementCount) {
      throw new CrossoverError(
        "VALIDATION",
        `Evidence for requirement ${e.requirement}, but the task has ${requirementCount}`,
        { details: { requirement: e.requirement, requirements: requirementCount } },
      );
    }
    if (seen.has(e.requirement)) {
      throw new CrossoverError("VALIDATION", `Requirement ${e.requirement} has evidence twice`, {
        details: { requirement: e.requirement },
      });
    }
    seen.add(e.requirement);
  }
  const bytes = Buffer.byteLength(JSON.stringify(evidence), "utf8");
  if (bytes > MAX_EVIDENCE_BYTES) {
    throw new CrossoverError(
      "VALIDATION",
      `Evidence is ${bytes} bytes; at most ${MAX_EVIDENCE_BYTES}`,
      { details: { bytes, limit: MAX_EVIDENCE_BYTES } },
    );
  }
}

/** The requirement indices with no proof, in order. */
export function missingEvidence(
  requirementCount: number,
  evidence: readonly EvidenceItem[],
): number[] {
  const proven = new Set(evidence.filter((e) => e.proof.length > 0).map((e) => e.requirement));
  const missing: number[] = [];
  for (let i = 0; i < requirementCount; i++) if (!proven.has(i)) missing.push(i);
  return missing;
}
