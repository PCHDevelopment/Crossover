import { describe, expect, it } from "vitest";
import { changesSubmitParamsSchema } from "./sandbox-submit.js";

describe("changes.submit contract", () => {
  it("accepts exact paths and trailing-slash directory prefixes, but not globs", () => {
    expect(
      changesSubmitParamsSchema.parse({
        paths: ["src/file.ts", "packages/workspace/", "app/[slug]/page.tsx"],
        message: "Submit working copy",
      }).paths,
    ).toEqual(["src/file.ts", "packages/workspace/", "app/[slug]/page.tsx"]);
    expect(changesSubmitParamsSchema.safeParse({ paths: ["src/*.ts"], message: "x" }).success).toBe(
      false,
    );
    expect(() => changesSubmitParamsSchema.parse({ paths: ["../secret"], message: "x" })).toThrow(
      "Path contains a parent segment",
    );
  });
});
