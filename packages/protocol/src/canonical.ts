import { createHash } from "node:crypto";

const MAX_DEPTH = 512;

/**
 * Deterministic JSON for hashing (T109): object keys sorted recursively (by UTF-16 code
 * unit, like RFC 8785), no whitespace, numbers and strings as `JSON.stringify` writes them.
 *
 * Throws `TypeError` for anything JSON can't represent faithfully: `undefined` (including
 * object properties and array holes), functions, symbols, bigints, non-finite numbers,
 * non-plain objects (Date, Map, class instances, ...) and circular references.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, [], "$");
}

function encode(value: unknown, ancestors: object[], path: string): string {
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      return JSON.stringify(value); // -0 becomes "0"
    case "object":
      break;
    default:
      // undefined, function, symbol, bigint
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }

  if (value === null) return "null";
  if (ancestors.includes(value)) {
    throw new TypeError(`canonicalJson: circular reference at ${path}`);
  }
  if (ancestors.length >= MAX_DEPTH) {
    throw new TypeError(`canonicalJson: nesting deeper than ${MAX_DEPTH} at ${path}`);
  }
  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i++) {
        items.push(encode(value[i], ancestors, `${path}[${i}]`));
      }
      return `[${items.join(",")}]`;
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`canonicalJson: unsupported object type at ${path}`);
    }
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key], ancestors, `${path}.${key}`)}`);
    return `{${members.join(",")}}`;
  } finally {
    ancestors.pop();
  }
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `input`. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
