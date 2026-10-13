import type { SandboxOutputUpdate } from "./ws.js";

export interface SandboxOutputTextChunk {
  stream: "stdout" | "stderr";
  text: string;
}

type BufferedOutputUpdate =
  | {
      kind: "data" | "truncated";
      sequence: number;
      chunks: SandboxOutputTextChunk[];
      outputBytes: number;
      bufferLimitReached: boolean;
      truncated: boolean;
    }
  | {
      kind: "finished";
      sequence: number;
      chunks: SandboxOutputTextChunk[];
      outputBytes: number;
      bufferLimitReached: boolean;
      truncated: boolean;
      exit_code: number | null;
      duration_ms: number | null;
      reason: string | null;
    };

/** Decodes and bounds rendered output while preserving per-stream UTF-8 boundaries. */
export class SandboxOutputBuffer {
  private readonly decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  private outputBytes = 0;
  private bufferLimitReached = false;
  private truncated = false;

  constructor(private readonly maxBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  push(update: SandboxOutputUpdate): BufferedOutputUpdate {
    if (update.kind === "data") {
      const acceptedBytes = Math.min(update.data.byteLength, this.maxBytes - this.outputBytes);
      this.outputBytes += acceptedBytes;
      this.bufferLimitReached ||= acceptedBytes < update.data.byteLength;
      this.truncated ||= this.bufferLimitReached;
      const text = this.decoders[update.stream].decode(update.data.subarray(0, acceptedBytes), {
        stream: true,
      });
      return {
        kind: "data",
        sequence: update.sequence,
        chunks: text ? [{ stream: update.stream, text }] : [],
        outputBytes: this.outputBytes,
        bufferLimitReached: this.bufferLimitReached,
        truncated: this.truncated,
      };
    }

    if (update.kind === "truncated") {
      this.truncated = true;
      return {
        kind: "truncated",
        sequence: update.sequence,
        chunks: [],
        outputBytes: this.outputBytes,
        bufferLimitReached: this.bufferLimitReached,
        truncated: true,
      };
    }

    const chunks = (Object.keys(this.decoders) as (keyof typeof this.decoders)[])
      .map((stream) => ({ stream, text: this.decoders[stream].decode() }))
      .filter((chunk) => chunk.text.length > 0);
    this.truncated ||= update.truncated;
    return {
      kind: "finished",
      sequence: update.sequence,
      chunks,
      outputBytes: this.outputBytes,
      bufferLimitReached: this.bufferLimitReached,
      truncated: this.truncated,
      exit_code: update.exit_code,
      duration_ms: update.duration_ms,
      reason: update.reason,
    };
  }
}
