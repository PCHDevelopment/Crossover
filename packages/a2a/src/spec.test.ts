import { describe, expect, it } from "vitest";
import {
  A2A_ERRORS,
  TASK_STATES,
  agentCardSchema,
  jsonRpcError,
  partSchema,
  sendMessageResponseSchema,
} from "./spec.js";

describe("A2A v1.0.0 wire schemas", () => {
  it("parses the example agent card with a JSON-RPC interface", () => {
    const card = agentCardSchema.parse({
      name: "Recipe Agent",
      description: "Helps with recipes",
      version: "1.0.0",
      supportedInterfaces: [
        {
          url: "https://example.com/a2a",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
      ],
      capabilities: { streaming: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [{ id: "recipes", name: "Recipes", description: "Find recipes", tags: ["food"] }],
    });
    expect(card.supportedInterfaces[0]?.protocolBinding).toBe("JSONRPC");
  });

  it("requires exactly one part payload", () => {
    expect(partSchema.safeParse({ text: "hello", raw: "aGVsbG8=" }).success).toBe(false);
    expect(partSchema.safeParse({ filename: "empty" }).success).toBe(false);
    expect(partSchema.safeParse({ data: null }).success).toBe(true);
  });

  it("strips unknown fields for newer peers", () => {
    expect(partSchema.parse({ text: "hello", future: true })).toEqual({ text: "hello" });
  });

  it("limits raw parts by decoded bytes", () => {
    expect(
      partSchema.safeParse({ raw: Buffer.alloc(1024 * 1024).toString("base64") }).success,
    ).toBe(true);
    expect(
      partSchema.safeParse({ raw: Buffer.alloc(1024 * 1024 + 1).toString("base64") }).success,
    ).toBe(false);
    expect(partSchema.safeParse({ raw: "invalid!" }).success).toBe(false);
  });

  it("uses exactly the eight specified states", () => {
    expect(TASK_STATES).toEqual([
      "TASK_STATE_SUBMITTED",
      "TASK_STATE_WORKING",
      "TASK_STATE_COMPLETED",
      "TASK_STATE_FAILED",
      "TASK_STATE_CANCELED",
      "TASK_STATE_INPUT_REQUIRED",
      "TASK_STATE_REJECTED",
      "TASK_STATE_AUTH_REQUIRED",
    ]);
  });

  it("accepts one SendMessage result and builds JSON-RPC errors", () => {
    expect(
      sendMessageResponseSchema.safeParse({
        message: { messageId: "m", role: "ROLE_AGENT", parts: [{ text: "hello" }] },
      }).success,
    ).toBe(true);
    expect(
      jsonRpcError(7, A2A_ERRORS.InvalidParams, "Invalid parameters", [{ "@type": "test" }]),
    ).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602, message: "Invalid parameters", data: [{ "@type": "test" }] },
    });
  });
});
