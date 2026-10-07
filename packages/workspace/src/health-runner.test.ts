import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { git } from "./git.js";
import {
  DEFAULT_HEALTH_IMAGE,
  DockerHealthRunner,
  runHealthCheck,
  storeHealthRun,
} from "./health-runner.js";

const directories: string[] = [];
const dockerImageAvailable = (() => {
  try {
    execFileSync("docker", ["image", "inspect", DEFAULT_HEALTH_IMAGE], {
      stdio: "ignore",
      timeout: 1000,
    });
    return true;
  } catch {
    return false;
  }
})();
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.pool.query(`
    INSERT INTO rooms (id, slug, name, objective, owner_id)
    VALUES ('room_health', 'health', 'Health', 'Test runner', 'owner_health');
    INSERT INTO workspaces (id, room_id, repo_path)
    VALUES ('ws_health', 'room_health', '/repo.git');
    INSERT INTO workspace_revisions (workspace_id, room_id, revision, commit_sha)
    VALUES ('ws_health', 'room_health', 0, 'commit_health');
  `);
});

afterAll(async () => {
  await db?.drop();
});

async function makeRepo(): Promise<{ repository: string; revision: string }> {
  const repository = await mkdtemp(join(tmpdir(), "crossover-health-test-repo-"));
  directories.push(repository);
  await git(["init", "--quiet", repository], { timeoutMs: 10_000 });
  await writeFile(join(repository, "sentinel.txt"), "target revision\n");
  await git(["add", "sentinel.txt"], { cwd: repository, timeoutMs: 10_000 });
  await git(
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "health fixture",
    ],
    {
      cwd: repository,
      timeoutMs: 10_000,
    },
  );
  const revision = (
    await git(["rev-parse", "HEAD"], { cwd: repository, timeoutMs: 10_000 })
  ).stdout.trim();
  return { repository, revision };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DockerHealthRunner", () => {
  it.each([
    { code: 0, timedOut: false, status: "GREEN" },
    { code: 1, timedOut: false, status: "RED" },
    { code: null, timedOut: true, status: "ERROR" },
    { code: null, timedOut: false, status: "ERROR" },
  ] as const)("maps process result to $status", async ({ code, timedOut, status }) => {
    const { repository, revision } = await makeRepo();
    let checkedOutText = "";
    const invoke = vi.fn(async (_binary: string, args: readonly string[]) => {
      const volume = args[args.indexOf("--volume") + 1]!;
      const checkout = volume.slice(0, volume.lastIndexOf(":/workspace:ro"));
      checkedOutText = await readFile(join(checkout, "sentinel.txt"), "utf8");
      return { code, timedOut, output: "runner output" };
    });
    const runner = new DockerHealthRunner({ timeoutMs: 1234 }, invoke);

    const result = await runner.run({ repository, revision, command: "npm test" });

    expect(result.status).toBe(status);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.log).toContain(timedOut ? "timed out" : "runner output");
    const [binary, args] = invoke.mock.calls[0]!;
    expect(binary).toBe("docker");
    expect(args).toContain("--network=none");
    expect(args).toContain(DEFAULT_HEALTH_IMAGE);
    expect(args).toContain("--read-only");
    expect(args).toContain("--user=1000:1000");
    expect(args).toContain("--network=none");
    expect(args.at(-1)).toBe("npm test");
    expect(checkedOutText).toBe("target revision\n");
    const volume = args[args.indexOf("--volume") + 1]!;
    expect(volume.endsWith(":/workspace:ro")).toBe(true);
    const checkout = volume.slice(0, volume.lastIndexOf(":/workspace:ro"));
    await expect(readFile(join(checkout, "sentinel.txt"), "utf8")).rejects.toThrow();
  });

  it("validates runner configuration", () => {
    expect(() => new DockerHealthRunner({ image: "  " })).toThrow(/allowlist/);
    expect(() => new DockerHealthRunner({ allowedImages: [] })).toThrow(/allowlist/);
    expect(() => new DockerHealthRunner({ timeoutMs: 0 })).toThrow(/timeout/);
  });

  it("refuses room-selected images outside the operator allowlist", async () => {
    const { repository, revision } = await makeRepo();
    const invoke = vi.fn();
    const result = await new DockerHealthRunner({}, invoke).run({
      repository,
      revision,
      command: "true",
      image: "attacker.invalid/image:latest",
    });
    expect(result.status).toBe("ERROR");
    expect(result.log).toContain("not operator-allowed");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.skipIf(!dockerImageAvailable)("runs the configured allowlisted image in Docker", async () => {
    const { repository, revision } = await makeRepo();
    const result = await new DockerHealthRunner({ allowedImages: [DEFAULT_HEALTH_IMAGE] }).run({
      repository,
      revision,
      command: "printf docker-health-ok",
    });
    expect(result.status).toBe("GREEN");
    expect(result.log).toContain("docker-health-ok");
  });

  it("persists results against the exact room-scoped workspace revision", async () => {
    const id = await storeHealthRun(db.pool, {
      workspaceId: "ws_health",
      roomId: "room_health",
      revision: 0,
      result: { status: "GREEN", durationMs: 25, log: "ok" },
    });
    const { rows } = await db.pool.query("SELECT * FROM health_runs WHERE id = $1", [id]);
    expect(rows[0]).toMatchObject({
      id,
      workspace_id: "ws_health",
      room_id: "room_health",
      revision: "0",
      status: "GREEN",
      duration_ms: 25,
      log: "ok",
    });
    await expect(
      storeHealthRun(db.pool, {
        workspaceId: "ws_health",
        roomId: "room_health",
        revision: 9,
        result: { status: "RED", durationMs: 1, log: "failed" },
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("uses the room health_command and persists the matching commit result", async () => {
    const run = vi.fn(async () => ({ status: "RED" as const, durationMs: 8, log: "failed" }));
    const runner = { run };
    await expect(runHealthCheck(db.pool, runner, "room_health", 0)).resolves.toBeNull();
    expect(run).not.toHaveBeenCalled();

    await db.pool.query("UPDATE rooms SET settings = $2 WHERE id = $1", [
      "room_health",
      JSON.stringify({ health_command: "pnpm test", health_image: "node:20" }),
    ]);
    const completed = await runHealthCheck(db.pool, runner, "room_health", 0);
    expect(run).toHaveBeenCalledWith({
      repository: "/repo.git",
      revision: "commit_health",
      command: "pnpm test",
      image: "node:20",
    });
    expect(completed?.result.status).toBe("RED");
    const { rows } = await db.pool.query(
      "SELECT revision, status, log FROM health_runs WHERE id = $1",
      [completed?.id],
    );
    expect(rows[0]).toMatchObject({ revision: "0", status: "RED", log: "failed" });
  });
});
