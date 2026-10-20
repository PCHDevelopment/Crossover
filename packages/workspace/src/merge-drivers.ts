export interface MergeDriverInput {
  path: string;
  base: string;
  head: string;
  candidate: string;
}

export type MergeDriverRefusal =
  | "parse_error"
  | "same_key"
  | "add_add"
  | "delete_modify"
  | "duplicate_key"
  | "unkeyed_change"
  | "reorder"
  | "trailer"
  | "result_parse_error"
  | "verify_mismatch"
  | "not_canonical"
  | "unsupported"
  | "too_large"
  | "driver_error";

export type MergeDriverOutcome =
  { ok: true; content: string } | { ok: false; reason: MergeDriverRefusal };

export interface MergeDriver {
  readonly name: string;
  matches(path: string): boolean;
  merge(input: MergeDriverInput): Promise<MergeDriverOutcome>;
}

export interface StructuredMergeRecord {
  path: string;
  driver: string;
}

export interface StructuredMergeRefusalRecord {
  path: string;
  driver: string | null;
  reason: MergeDriverRefusal | "ineligible" | "no_driver" | "budget" | "not_utf8";
}

export const STRUCTURED_MERGE_MAX_FILES = 20;
export const STRUCTURED_MERGE_FILE_MAX_BYTES = 1024 * 1024;
export const STRUCTURED_MERGE_BUDGET_BYTES = 2 * 1024 * 1024;

let defaultDrivers: readonly MergeDriver[] = Object.freeze([]);

/** Set the process default without retaining a mutable caller-owned array. */
export function setDefaultMergeDrivers(drivers: readonly MergeDriver[]): void {
  defaultDrivers = Object.freeze([...drivers]);
}

export function defaultMergeDrivers(): readonly MergeDriver[] {
  return defaultDrivers;
}

/** Shipped drivers are registered by later tasks. */
export function structuredMergeDrivers(): MergeDriver[] {
  return [];
}
