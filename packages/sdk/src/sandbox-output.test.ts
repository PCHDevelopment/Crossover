import { describe, expect, it } from "vitest";
import {
  SandboxOutputBuffer,
  SandboxOutputSubscription,
  type SandboxOutputUpdate,
  type WebSocketCtor,
  type WebSocketLike,
} from "./index.js";
import type { WsConfig } from "./ws.js";

const execId = "exec_123456789012345678901234";

describe("SandboxOutputBuffer", () => {
  it("bounds rendered output and keeps UTF-8 characters split across chunks intact", () => {
    const buffer = new SandboxOutputBuffer(4);
    const encoded = new TextEncoder().encode("🌟!");
    expect(
      buffer.push({
        kind: "data",
        exec_id: execId,
        sequence: 1,
        stream: "stdout",
        data: encoded.subarray(0, 2),
      }),
    ).toMatchObject({ chunks: [], outputBytes: 2, bufferLimitReached: false });
    expect(
      buffer.push({
        kind: "data",
        exec_id: execId,
        sequence: 2,
        stream: "stdout",
        data: encoded.subarray(2),
      }),
    ).toMatchObject({
      chunks: [{ stream: "stdout", text: "🌟" }],
      outputBytes: 4,
      bufferLimitReached: true,
      truncated: true,
    });
    expect(
      buffer.push({
        kind: "finished",
        exec_id: execId,
        sequence: 2,
        exit_code: 0,
        duration_ms: 10,
        reason: "exit",
        truncated: false,
      }),
    ).toMatchObject({ kind: "finished", bufferLimitReached: true, truncated: true });
  });
});

class FakeSocket implements WebSocketLike {
  static onClientFrame: ((socket: FakeSocket, frame: Record<string, unknown>) => void) | undefined;

  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(_url: string) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame["type"] === "hello") {
      queueMicrotask(() => this.receive({ type: "hello_ok" }));
      return;
    }
    FakeSocket.onClientFrame?.(this, frame);
  }

  close(code = 1000, reason = "closed"): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function config(): WsConfig {
  return {
    url: "ws://localhost/v1/rooms/room_123456789012345678901234/ws",
    token: "token",
    WebSocket: FakeSocket as unknown as WebSocketCtor,
    client: "test",
    clientVersion: "1",
    readTimeoutMs: 1_000,
  };
}

describe("SandboxOutputSubscription", () => {
  it("decodes output and delivers truncation and completion in cursor order", async () => {
    FakeSocket.onClientFrame = (socket, frame) => {
      if (frame["type"] !== "sandbox.output.subscribe") return;
      const after = frame["after"] as number;
      socket.receive({
        type: "sandbox.output.subscribed",
        exec_id: execId,
        after,
        last_sequence: 2,
      });
      socket.receive({
        type: "sandbox.output",
        exec_id: execId,
        sequence: 1,
        stream: "stderr",
        encoding: "base64",
        data: "aGVsbG8=",
      });
      socket.receive({ type: "sandbox.output.truncated", exec_id: execId, sequence: 2 });
      socket.receive({
        type: "sandbox.output.finished",
        exec_id: execId,
        sequence: 2,
        exit_code: 4,
        duration_ms: 12,
        reason: "exit",
        truncated: true,
      });
    };
    const updates: SandboxOutputUpdate[] = [];
    const finished = new Promise<SandboxOutputUpdate>((resolve, reject) => {
      const subscription = new SandboxOutputSubscription(config(), execId, {
        onUpdate: (update) => {
          updates.push(update);
          if (update.kind === "finished") resolve(update);
        },
        onError: reject,
        reconnect: { minMs: 1, maxMs: 1 },
      });
      void subscription;
    });

    await expect(finished).resolves.toMatchObject({
      kind: "finished",
      exit_code: 4,
      truncated: true,
    });
    expect(updates).toEqual([
      {
        kind: "data",
        exec_id: execId,
        sequence: 1,
        stream: "stderr",
        data: new TextEncoder().encode("hello"),
      },
      { kind: "truncated", exec_id: execId, sequence: 2 },
      expect.objectContaining({ kind: "finished", sequence: 2 }),
    ]);
  });

  it("resubscribes from the last delivered cursor after server backpressure", async () => {
    const cursors: number[] = [];
    const states: string[] = [];
    FakeSocket.onClientFrame = (socket, frame) => {
      if (frame["type"] !== "sandbox.output.subscribe") return;
      const after = frame["after"] as number;
      cursors.push(after);
      socket.receive({
        type: "sandbox.output.subscribed",
        exec_id: execId,
        after,
        last_sequence: 2,
      });
      if (cursors.length === 1) {
        socket.receive({
          type: "sandbox.output",
          exec_id: execId,
          sequence: 1,
          stream: "stdout",
          encoding: "base64",
          data: "YQ==",
        });
        socket.receive({ type: "sandbox.output.resync_required", exec_id: execId, after: 1 });
      } else {
        socket.receive({
          type: "sandbox.output",
          exec_id: execId,
          sequence: 2,
          stream: "stdout",
          encoding: "base64",
          data: "Yg==",
        });
        socket.receive({
          type: "sandbox.output.finished",
          exec_id: execId,
          sequence: 2,
          exit_code: 0,
          duration_ms: 20,
          reason: "exit",
          truncated: false,
        });
      }
    };
    const updates: SandboxOutputUpdate[] = [];
    const finished = new Promise<SandboxOutputUpdate>((resolve, reject) => {
      const subscription = new SandboxOutputSubscription(config(), execId, {
        onState: (state) => states.push(state),
        onUpdate: (update) => {
          updates.push(update);
          if (update.kind === "finished") resolve(update);
        },
        onError: reject,
      });
      void subscription;
    });

    await expect(finished).resolves.toMatchObject({ kind: "finished", exit_code: 0 });
    expect(cursors).toEqual([0, 1]);
    expect(
      updates.filter((update) => update.kind === "data").map((update) => update.sequence),
    ).toEqual([1, 2]);
    expect(states).toContain("reconnecting");
    expect(states.filter((state) => state === "live").length).toBeGreaterThanOrEqual(2);
  });

  it("replays from the last delivered cursor after a dropped WebSocket", async () => {
    const cursors: number[] = [];
    FakeSocket.onClientFrame = (socket, frame) => {
      if (frame["type"] !== "sandbox.output.subscribe") return;
      const after = frame["after"] as number;
      cursors.push(after);
      socket.receive({
        type: "sandbox.output.subscribed",
        exec_id: execId,
        after,
        last_sequence: 2,
      });
      if (cursors.length === 1) {
        socket.receive({
          type: "sandbox.output",
          exec_id: execId,
          sequence: 1,
          stream: "stdout",
          encoding: "base64",
          data: "YQ==",
        });
        socket.close(1006, "test disconnect");
      } else {
        socket.receive({
          type: "sandbox.output",
          exec_id: execId,
          sequence: 2,
          stream: "stderr",
          encoding: "base64",
          data: "Yg==",
        });
        socket.receive({
          type: "sandbox.output.finished",
          exec_id: execId,
          sequence: 2,
          exit_code: 0,
          duration_ms: 20,
          reason: "exit",
          truncated: false,
        });
      }
    };
    const sequences: number[] = [];
    const finished = new Promise<SandboxOutputUpdate>((resolve, reject) => {
      const subscription = new SandboxOutputSubscription(config(), execId, {
        onUpdate: (update) => {
          if (update.kind === "data") sequences.push(update.sequence);
          if (update.kind === "finished") resolve(update);
        },
        onError: reject,
        reconnect: { minMs: 1, maxMs: 1 },
      });
      void subscription;
    });

    await expect(finished).resolves.toMatchObject({ kind: "finished", exit_code: 0 });
    expect(cursors).toEqual([0, 1]);
    expect(sequences).toEqual([1, 2]);
  });
});
