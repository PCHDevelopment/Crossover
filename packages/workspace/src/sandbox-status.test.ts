import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext, CommandDefinition, Dispatcher } from "@crossover/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git } from "./git.js";
import type { SandboxWorkingCopyStatus } from "./execution.js";
import { parsePorcelainStatus, registerSandboxStatusCommand } from "./sandbox-status.js";
import type { sandboxStatusParamsSchema } from "./sandbox-status.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("parsePorcelainStatus", () => {
  it("reports modifications, additions, deletions and renames while omitting ignored paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "crossover-sandbox-status-test-"));
    roots.push(root);
    const env = {
      GIT_AUTHOR_NAME: "Crossover test",
      GIT_AUTHOR_EMAIL: "test@crossover.invalid",
      GIT_COMMITTER_NAME: "Crossover test",
      GIT_COMMITTER_EMAIL: "test@crossover.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const run = (args: string[]) => git(args, { cwd: root, timeoutMs: 10_000, env });

    await run(["init", "--quiet", "--initial-branch=main"]);
    await writeFile(join(root, ".gitignore"), "*.log\n");
    await writeFile(join(root, ".roomignore"), "secret-cache/\n");
    await writeFile(join(root, "modified.txt"), "before");
    await writeFile(join(root, "deleted.txt"), "remove me");
    await writeFile(join(root, "renamed-old.txt"), "rename me");
    await run(["add", "."]);
    await run(["commit", "--quiet", "-m", "fixture"]);

    await writeFile(join(root, "modified.txt"), "after");
    await rm(join(root, "deleted.txt"));
    await rename(join(root, "renamed-old.txt"), join(root, "renamed-new.txt"));
    await writeFile(join(root, "added.txt"), "new");
    await writeFile(join(root, "ignored.log"), "generated");
    await mkdir(join(root, "secret-cache"));
    await writeFile(join(root, "secret-cache", "generated.txt"), "generated");

    const { stdout } = await run([
      "-c",
      `core.excludesFile=${join(root, ".roomignore")}`,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--no-renames",
    ]);
    expect(parsePorcelainStatus(stdout)).toEqual({
      modified: ["modified.txt"],
      added: ["added.txt", "renamed-new.txt"],
      deleted: ["deleted.txt", "renamed-old.txt"],
    });
  });
});

describe("registerSandboxStatusCommand", () => {
  it("registers a read-only sandbox.read command for the caller's own status", async () => {
    const definitions: unknown[] = [];
    const dispatcher = {
      registerCommand: (definition: unknown) => definitions.push(definition),
    } as unknown as Dispatcher;
    const response: SandboxWorkingCopyStatus = {
      base_revision: 4,
      head_revision: 5,
      behind_by: 1,
      modified: ["src/app.ts"],
      added: [],
      deleted: [],
    };
    const status = vi.fn(async () => response);

    registerSandboxStatusCommand(dispatcher, { status });

    const definition = definitions[0] as CommandDefinition<
      typeof sandboxStatusParamsSchema,
      SandboxWorkingCopyStatus
    >;
    expect(definition).toMatchObject({
      method: "sandbox.status",
      action: "sandbox.read",
      mutating: false,
      view: "own",
    });
    expect(definition.params.safeParse({}).success).toBe(true);
    await expect(
      definition.execute(
        {
          room_id: "room_status",
          principal: { participant_id: "part_status" },
        } as unknown as CommandContext,
        {},
      ),
    ).resolves.toEqual({ response });
    expect(status).toHaveBeenCalledWith("room_status", "part_status");
  });
});
