import { PUBLIC_ERROR_CODES } from "@crossover/protocol";

const HEADER =
  "// Generated from PUBLIC_ERROR_CODES in packages/protocol/src/errors.ts. Do not edit.\n";

/** The Go CLI's stable process status for each public protocol error. */
export function renderGoErrorCatalog(): string {
  const names = PUBLIC_ERROR_CODES.map((code) => JSON.stringify(code));
  const width = Math.max(...names.map((name) => name.length));
  return (
    HEADER +
    "package cli\n\n" +
    "var protocolExitCodes = map[string]int{\n" +
    names
      .map((name, index) => `\t${name}:${" ".repeat(width - name.length + 1)}${index + 10},`)
      .join("\n") +
    "\n}\n"
  );
}
