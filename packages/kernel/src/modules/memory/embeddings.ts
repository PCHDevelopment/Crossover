/** A deterministic or remote provider that embeds batches of text. */
export interface EmbeddingProvider {
  /** Stable identifier stored in memory_embeddings.model. */
  readonly model: string;
  /** Number of float32 values in every returned vector. */
  readonly dimensions: number;
  /** Maximum text length the provider accepts, measured in Unicode code points. */
  readonly maxInputChars: number;
  /** Return one vector per text, in order; the caller normalizes vectors before storing them. */
  embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]>;
}

const DIMENSIONS = 256;
const HASH_OFFSET_BASIS = 0x811c9dc5;
const HASH_PRIME = 0x01000193;

/** Normalize a vector to unit length, leaving a zero vector at zero. */
export function normalize(vector: Float32Array): Float32Array {
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new RangeError("Vector values must be finite");
    squaredNorm += value * value;
  }
  if (squaredNorm === 0) return new Float32Array(vector.length);
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm)) throw new RangeError("Vector norm must be finite");
  return Float32Array.from(vector, (value) => value / norm);
}

/** Encode float32 values in little-endian byte order. */
export function encodeVector(vector: Float32Array): Buffer {
  const encoded = Buffer.allocUnsafe(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) encoded.writeFloatLE(vector[i]!, i * 4);
  return encoded;
}

/** Decode a little-endian float32 vector and reject an unexpected byte length. */
export function decodeVector(bytes: Buffer, dimensions: number): Float32Array {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > 4096)
    throw new RangeError("dimensions must be an integer between 1 and 4096");
  if (bytes.length !== dimensions * 4)
    throw new RangeError("Encoded vector length does not match dimensions");
  const vector = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i += 1) vector[i] = bytes.readFloatLE(i * 4);
  return vector;
}

/** Return the dot product of equal-length, unit-normalized vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new RangeError("Vectors must have the same dimensions");
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!;
  return dot;
}

/** Combine a memory key and value, truncating by Unicode code point. */
export function embeddingText(key: string, value: string, max: number): string {
  if (!Number.isSafeInteger(max) || max < 0)
    throw new RangeError("max must be a non-negative safe integer");
  const text = `${key}\n\n${value}`;
  return Array.from(text).slice(0, max).join("");
}

function fnv1a(feature: string): number {
  let hash = HASH_OFFSET_BASIS;
  for (const byte of Buffer.from(feature, "utf8")) hash = Math.imul(hash ^ byte, HASH_PRIME) >>> 0;
  return hash;
}

function addFeature(vector: Float64Array, feature: string, weight: number): void {
  const hash = fnv1a(feature);
  const index = hash % DIMENSIONS;
  vector[index] = vector[index]! + (hash >>> 31 === 1 ? -weight : weight);
}

function hashEmbedding(text: string): Float32Array {
  const vector = new Float64Array(DIMENSIONS);
  const normalized = text.normalize("NFKC").toLowerCase();
  for (const token of normalized.split(/[^\p{L}\p{N}]+/u)) {
    const characters = Array.from(token);
    if (characters.length === 0) continue;
    addFeature(vector, token, 1);
    const padded = Array.from(`#${token}#`);
    for (let i = 0; i + 3 <= padded.length; i += 1)
      addFeature(vector, padded.slice(i, i + 3).join(""), 0.5);
  }
  return normalize(Float32Array.from(vector));
}

/** Deterministic, local-only hashing provider for development and tests. */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly model = "local-hash-v1";
  readonly dimensions = DIMENSIONS;
  readonly maxInputChars = 16_384;

  /** Embed text using normalized token and character-trigram hashing without I/O. */
  async embed(texts: string[], signal: AbortSignal): Promise<Float32Array[]> {
    signal.throwIfAborted();
    const vectors: Float32Array[] = [];
    for (const text of texts) {
      signal.throwIfAborted();
      let length = 0;
      for (let index = 0; index < text.length;) {
        index += text.codePointAt(index)! > 0xffff ? 2 : 1;
        if (++length > this.maxInputChars)
          throw new RangeError(`Embedding input exceeds ${this.maxInputChars} code points`);
      }
      vectors.push(hashEmbedding(text));
    }
    return vectors;
  }
}
