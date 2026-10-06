import { CrossoverError } from "@crossover/protocol";
import type { ContentEncoding } from "./operations.js";

/** Validate canonical RFC 4648 base64 and measure decoded bytes without allocating them. */
export function contentSize(content: string | Buffer, encoding?: ContentEncoding): number {
  if (Buffer.isBuffer(content)) return content.length;
  if (encoding !== "base64") return Buffer.byteLength(content);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (
    content.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(content) ||
    (content.endsWith("==") && alphabet.indexOf(content.at(-3)!) % 16 !== 0) ||
    (content.endsWith("=") &&
      !content.endsWith("==") &&
      alphabet.indexOf(content.at(-2)!) % 4 !== 0)
  ) {
    throw new CrossoverError("VALIDATION", "Invalid base64 content", {
      details: { reason: "invalid_base64" },
    });
  }
  return (content.length / 4) * 3 - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);
}

export function contentBytes(content: string | Buffer, encoding?: ContentEncoding): Buffer {
  contentSize(content, encoding);
  return Buffer.isBuffer(content) ? content : Buffer.from(content, encoding ?? "utf8");
}
