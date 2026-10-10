import type { CommandDefinition, Dispatcher } from "@crossover/kernel";
import { describe, expect, it } from "vitest";
import { changesSubmitParamsSchema, registerSandboxSubmitCommand } from "./sandbox-submit.js";

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

  it("registers a mutating, per-path-authorized command", () => {
    const definitions: CommandDefinition<typeof changesSubmitParamsSchema, unknown>[] = [];
    const dispatcher = {
      registerCommand: (definition: CommandDefinition<typeof changesSubmitParamsSchema, unknown>) =>
        definitions.push(definition),
    } as unknown as Dispatcher;
    registerSandboxSubmitCommand(dispatcher, { supportsSandboxSubmit: () => true } as never);

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      method: "changes.submit",
      action: "workspace.write",
      perPathAuthorize: true,
      mutating: true,
    });
    expect(definitions[0]!.params.safeParse({ message: "Submit" }).success).toBe(true);
    expect(definitions[0]!.params.safeParse({ message: "Submit", extra: true }).success).toBe(
      false,
    );
  });
});
