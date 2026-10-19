import { describe, expect, it } from "vitest";
import {
  cosine,
  decodeVector,
  embeddingText,
  encodeVector,
  HashEmbeddingProvider,
} from "./embeddings.js";

const provider = new HashEmbeddingProvider();
const signal = () => new AbortController().signal;

function norm(vector: Float32Array): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

describe("HashEmbeddingProvider", () => {
  it("is deterministic and returns unit vectors while keeping empty input at zero", async () => {
    const [first, second, empty] = await provider.embed(
      ["Database migration plan", "Database migration plan", ""],
      signal(),
    );
    expect(first).toEqual(second);
    expect(norm(first!)).toBeCloseTo(1, 6);
    expect(empty!.every((value) => value === 0)).toBe(true);
  });

  it("ranks lexical neighbours above unrelated text", async () => {
    const [query, neighbour, unrelated] = await provider.embed(
      [
        "database migration plan",
        "plan the database schema migration",
        "button colour in the header",
      ],
      signal(),
    );
    expect(cosine(query!, neighbour!)).toBeGreaterThan(cosine(query!, unrelated!));
  });

  it("distinguishes single-character tokens from each other and empty text", async () => {
    const [a, b, empty] = await provider.embed(["a", "b", ""], signal());
    expect(norm(a!)).toBeCloseTo(1, 6);
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(empty);
  });

  it("enforces the input limit by Unicode code point", async () => {
    await expect(
      provider.embed(["😀".repeat(provider.maxInputChars)], signal()),
    ).resolves.toHaveLength(1);
    await expect(
      provider.embed(["short", "😀".repeat(provider.maxInputChars + 1)], signal()),
    ).rejects.toThrow(RangeError);
  });

  it("encodes and decodes float32 little-endian values", () => {
    const vector = Float32Array.from([1 / 3, -2.5, 0, Math.PI]);
    const encoded = encodeVector(vector);
    expect(encoded.readFloatLE(0)).toBe(vector[0]);
    expect(decodeVector(encoded, vector.length)).toEqual(vector);
    expect(() => decodeVector(encoded.subarray(1), vector.length)).toThrow(RangeError);
  });

  it("truncates embedding text by Unicode code point", () => {
    expect(embeddingText("🧠key", "value", 1)).toBe("🧠");
    expect(embeddingText("key", "value", 0)).toBe("");
    expect(embeddingText("key", "value", 5)).toBe("key\n\n");
  });

  it("honors an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(provider.embed(["text"], controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
