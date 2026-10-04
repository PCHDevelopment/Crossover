import { describe, expect, it } from "vitest";
import { CrossoverError, ERROR_CODES, PUBLIC_ERROR_CODES, toErrorBody } from "./errors.js";

describe("CrossoverError", () => {
  it("serializes exactly to the §16.3 shape", () => {
    const err = new CrossoverError("CONFLICT_VERSION", "Task was updated by another participant", {
      details: { current: { version: 4 } },
    });
    expect(toErrorBody(err)).toEqual({
      error: {
        code: "CONFLICT_VERSION",
        message: "Task was updated by another participant",
        retryable: true,
        details: { current: { version: 4 } },
      },
    });
    expect(err.toErrorBody()).toEqual(toErrorBody(err));
  });

  it("omits details when none are given", () => {
    const body = toErrorBody(new CrossoverError("NOT_FOUND", "no such room"));
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "retryable"]);
  });

  it("defaults CONFLICT_VERSION and RATE_LIMITED to retryable, FORBIDDEN not", () => {
    expect(new CrossoverError("CONFLICT_VERSION", "x").retryable).toBe(true);
    expect(new CrossoverError("RATE_LIMITED", "x").retryable).toBe(true);
    expect(new CrossoverError("FORBIDDEN", "x").retryable).toBe(false);
  });

  it("lets callers override retryable", () => {
    expect(new CrossoverError("FORBIDDEN", "x", { retryable: true }).retryable).toBe(true);
  });

  it("defines a default retryable for every code", () => {
    for (const code of ERROR_CODES) {
      expect(typeof new CrossoverError(code, "x").retryable).toBe("boolean");
    }
  });

  it("covers every §16.3 code plus the internal STALE_FENCE", () => {
    expect([...PUBLIC_ERROR_CODES]).toHaveLength(12);
    expect(ERROR_CODES).toContain("STALE_FENCE");
    expect(PUBLIC_ERROR_CODES).not.toContain("STALE_FENCE" as never);
  });

  it("is an Error with a name and preserves cause", () => {
    const cause = new Error("boom");
    const err = new CrossoverError("VALIDATION", "bad", { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CrossoverError");
    expect(err.cause).toBe(cause);
  });
});
