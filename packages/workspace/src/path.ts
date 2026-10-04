import { posix } from "node:path";

/** Invalid input at the workspace boundary; command handlers map this to VALIDATION. */
export class PathValidationError extends Error {
  readonly code = "VALIDATION";

  constructor(message: string) {
    super(message);
    this.name = "PathValidationError";
  }
}

/** Return a canonical, relative POSIX file path for ChangeSets (§10.3). */
export function normalizePath(p: string): string {
  const normalized = p.normalize("NFC");
  if (normalized.includes("\0")) throw new PathValidationError("Path contains NUL");
  if (normalized.startsWith("/")) throw new PathValidationError("Path must be relative");
  if (normalized.includes("\\")) throw new PathValidationError("Path must use POSIX separators");
  const segments = normalized.split("/");
  if (segments.includes("..")) throw new PathValidationError("Path contains a parent segment");
  if (segments.includes(".git")) throw new PathValidationError("Path contains a .git segment");
  if (Buffer.byteLength(normalized, "utf8") > 4096)
    throw new PathValidationError("Path exceeds 4096 bytes");
  const result = posix.normalize(normalized).replace(/\/$/, "");
  if (result === "." || result === "") throw new PathValidationError("Path must name a file");
  return result;
}
