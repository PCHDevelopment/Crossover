import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { git } from "./git.js";
import {
  DEFAULT_HEALTH_IMAGE,
  DEFAULT_HEALTH_LOCKFILE_PATHS,
  DockerHealthRunner,
  hashHealthLockfiles,
  normalizeHealthLockfilePaths,
  prepareHealthCheckout,
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

function dockerHealthContainers(): string[] {
  const output = execFileSync(
    "docker",
    ["ps", "-aq", "--filter", "label=crossover.health.runner=true"],
    {
      timeout: 1000,
    },
  )
    .toString("utf8")
    .trim();
  return output ? output.split("\n").sort() : [];
}
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

function fakeInstallDocker(installExitCode = 0) {
  let volumeExists = false;
  let installs = 0;
  let healthRuns = 0;
  const calls: string[][] = [];
  const invoke = vi.fn(async (_binary: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "network" && args[1] === "ls") return { code: 0, timedOut: false, output: "" };
    if (args[0] === "volume" && args[1] === "inspect")
      return { code: volumeExists ? 0 : 1, timedOut: false, output: "" };
    if (args[0] === "volume" && args[1] === "create") {
      volumeExists = true;
      return { code: 0, timedOut: false, output: "cache-volume" };
    }
    if (args[0] === "run" && args.includes("--user=0:0"))
      return { code: 0, timedOut: false, output: "" };
    if (args[0] === "run" && args.includes("crossover.health.install=true")) {
      installs++;
      expect(args.some((arg) => arg.startsWith("--network=crossover-health-install-"))).toBe(true);
      expect(args.some((arg) => arg.startsWith("HTTPS_PROXY=http://"))).toBe(true);
      return {
        code: installExitCode,
        timedOut: false,
        output: installExitCode === 0 ? "install ok" : "registry refused",
      };
    }
    if (args[0] === "run" && args.includes("crossover.health.runner=true")) {
      healthRuns++;
      return { code: 0, timedOut: false, output: "health ok" };
    }
    return { code: 0, timedOut: false, output: "" };
  });
  return {
    invoke,
    calls,
    installCount: () => installs,
    healthCount: () => healthRuns,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DockerHealthRunner", () => {
  it("maps root UID/GID to unprivileged 1000:1000 and changes checkout ownership", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "crossover-health-root-test-"));
    directories.push(checkout);
    const changeOwner = vi.fn(async () => {});
    await expect(prepareHealthCheckout(checkout, 0, 0, changeOwner)).resolves.toEqual({
      uid: 1000,
      gid: 1000,
    });
    expect(changeOwner).toHaveBeenCalledWith(checkout, 1000, 1000);
  });

  it.each([
    { code: 0, timedOut: false, status: "GREEN" },
    { code: 1, timedOut: false, status: "RED" },
    { code: null, timedOut: true, status: "ERROR" },
    { code: null, timedOut: false, status: "ERROR" },
  ] as const)("maps process result to $status", async ({ code, timedOut, status }) => {
    const { repository, revision } = await makeRepo();
    let checkedOutText = "";
    const invoke = vi.fn(
      async (
        _binary: string,
        args: readonly string[],
        options?: { onTimeout?: () => Promise<void> },
      ) => {
        if (args[0] !== "run") return { code: 0, timedOut: false, output: "" };
        const volume = args[args.indexOf("--volume") + 1]!;
        const checkout = volume.slice(0, volume.lastIndexOf(":/workspace:rw"));
        checkedOutText = await readFile(join(checkout, "sentinel.txt"), "utf8");
        if (timedOut) await options?.onTimeout?.();
        return { code, timedOut, output: "runner output" };
      },
    );
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
    const expectedUid = process.getuid?.() === 0 ? 1000 : (process.getuid?.() ?? 1000);
    const expectedGid = process.getgid?.() === 0 ? 1000 : (process.getgid?.() ?? 1000);
    expect(args).toContain(`--user=${expectedUid}:${expectedGid}`);
    expect(args).toContain("--init");
    expect(args).toContain("--env");
    expect(args).toContain("HOME=/tmp");
    expect(args).toContain("/tmp:rw,nosuid,size=512m");
    expect(args).toContain("crossover.health.runner=true");
    expect(args.at(-1)).toBe("npm test");
    expect(checkedOutText).toBe("target revision\n");
    const volume = args[args.indexOf("--volume") + 1]!;
    expect(volume.endsWith(":/workspace:rw")).toBe(true);
    const checkout = volume.slice(0, volume.lastIndexOf(":/workspace:rw"));
    await expect(readFile(join(checkout, "sentinel.txt"), "utf8")).rejects.toThrow();
    expect(invoke.mock.calls.map((call) => call[1][0])).toEqual(
      timedOut ? ["run", "kill", "rm"] : ["run", "rm"],
    );
  });

  it("validates runner configuration", () => {
    expect(() => new DockerHealthRunner({ image: "  " })).toThrow(/allowlist/);
    expect(() => new DockerHealthRunner({ allowedImages: [] })).toThrow(/allowlist/);
    expect(() => new DockerHealthRunner({ timeoutMs: 0 })).toThrow(/timeout/);
    expect(() => new DockerHealthRunner({ egressProxyContainer: "proxy" })).toThrow(/SECRET/);
  });

  it("refuses room-selected images outside the operator allowlist", async () => {
    const { repository, revision } = await makeRepo();
    const invoke = vi.fn(async () => ({ code: 0, timedOut: false, output: "" }));
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

  it("installs dependencies once per cache key and keeps health runs isolated", async () => {
    await db.pool.query("DELETE FROM health_install_runs WHERE room_id = $1", ["room_health"]);
    const { repository } = await makeRepo();
    await writeFile(join(repository, "package-lock.json"), '{"lock":1}\n');
    const commit = async (message: string): Promise<string> => {
      await git(["add", "--all"], { cwd: repository, timeoutMs: 10_000 });
      await git(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--quiet",
          "-m",
          message,
        ],
        { cwd: repository, timeoutMs: 10_000 },
      );
      return (
        await git(["rev-parse", "HEAD"], { cwd: repository, timeoutMs: 10_000 })
      ).stdout.trim();
    };
    const firstRevision = await commit("add package lock");
    const docker = fakeInstallDocker();
    const runner = new DockerHealthRunner(
      {
        egressProxyContainer: "egress-proxy",
        egressProxySecret: "0123456789abcdef0123456789abcdef",
      },
      docker.invoke,
    );
    const dependencyInstall = {
      pool: db.pool,
      command: "npm ci",
      lockfilePaths: ["package-lock.json"],
    };
    const run = (revision: string) =>
      runner.run({
        repository,
        revision,
        roomId: "room_health",
        command: "npm test",
        dependencyInstall,
      });

    const first = await run(firstRevision);
    await writeFile(join(repository, "sentinel.txt"), "source-only change\n");
    const sameLocksRevision = await commit("change source only");
    const second = await run(sameLocksRevision);
    await writeFile(join(repository, "package-lock.json"), '{"lock":2}\n');
    const changedLocksRevision = await commit("update package lock");
    const third = await run(changedLocksRevision);

    expect([first.status, second.status, third.status]).toEqual(["GREEN", "GREEN", "GREEN"]);
    expect(docker.installCount()).toBe(2);
    expect(docker.healthCount()).toBe(3);
    expect(
      docker.calls.filter((args) => args[0] === "network" && args[1] === "create"),
    ).toHaveLength(2);
    expect(docker.calls.filter((args) => args[0] === "network" && args[1] === "rm")).toHaveLength(
      2,
    );
    const healthArgs = docker.calls.find((args) => args.includes("crossover.health.runner=true"))!;
    expect(healthArgs).toContain("--network=none");
    expect(healthArgs.some((arg) => arg.includes("target=/workspace/node_modules,readonly"))).toBe(
      true,
    );
    const { rows } = await db.pool.query(
      "SELECT status FROM health_install_runs WHERE room_id = $1 ORDER BY started_at",
      ["room_health"],
    );
    expect(rows.map((row) => row.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  });

  it("records install failure as ERROR and skips the health command", async () => {
    await db.pool.query("DELETE FROM health_install_runs WHERE room_id = $1", ["room_health"]);
    const { repository } = await makeRepo();
    await writeFile(join(repository, "package-lock.json"), "{}\n");
    await git(["add", "--all"], { cwd: repository, timeoutMs: 10_000 });
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "add lockfile",
      ],
      { cwd: repository, timeoutMs: 10_000 },
    );
    const revision = (
      await git(["rev-parse", "HEAD"], { cwd: repository, timeoutMs: 10_000 })
    ).stdout.trim();
    const docker = fakeInstallDocker(1);
    const result = await new DockerHealthRunner(
      {
        egressProxyContainer: "egress-proxy",
        egressProxySecret: "0123456789abcdef0123456789abcdef",
      },
      docker.invoke,
    ).run({
      repository,
      revision,
      roomId: "room_health",
      command: "npm test",
      dependencyInstall: {
        pool: db.pool,
        command: "npm ci",
        lockfilePaths: ["package-lock.json"],
      },
    });

    expect(result.status).toBe("ERROR");
    expect(result.log).toContain("registry refused");
    expect(result.log).toContain("installation failed");
    expect(docker.installCount()).toBe(1);
    expect(docker.healthCount()).toBe(0);
    const { rows } = await db.pool.query(
      "SELECT status FROM health_install_runs WHERE room_id = $1",
      ["room_health"],
    );
    expect(rows).toEqual([{ status: "FAILED" }]);
  });

  it.skipIf(!dockerImageAvailable)(
    "runs with a writable checkout as its unprivileged UID",
    async () => {
      const { repository, revision } = await makeRepo();
      const gid = process.getgid?.() === 0 ? 1000 : (process.getgid?.() ?? 1000);
      const result = await new DockerHealthRunner({ allowedImages: [DEFAULT_HEALTH_IMAGE] }).run({
        repository,
        revision,
        command: `test "$(id -u)" != 0 && test "$(id -g)" = ${gid} && test -w /workspace && printf docker-health-ok`,
      });
      expect(result.status).toBe("GREEN");
      expect(result.log).toContain("docker-health-ok");
    },
  );

  it.skipIf(!dockerImageAvailable)("blocks network access from the container", async () => {
    const { repository, revision } = await makeRepo();
    const result = await new DockerHealthRunner({ allowedImages: [DEFAULT_HEALTH_IMAGE] }).run({
      repository,
      revision,
      command:
        "node -e \"fetch('https://example.com',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(1),()=>process.exit(0))\"",
    });
    expect(result.status).toBe("GREEN");
  });

  it.skipIf(!dockerImageAvailable)("keeps successful status with output over 1 MiB", async () => {
    const { repository, revision } = await makeRepo();
    const result = await new DockerHealthRunner({ allowedImages: [DEFAULT_HEALTH_IMAGE] }).run({
      repository,
      revision,
      command: "node -e \"process.stdout.write('x'.repeat(2*1024*1024))\"",
    });
    expect(result.status).toBe("GREEN");
    expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(1024 * 1024 + 20);
  });

  it.skipIf(!dockerImageAvailable)("kills and removes a container on timeout", async () => {
    const before = dockerHealthContainers();
    const { repository, revision } = await makeRepo();
    const result = await new DockerHealthRunner({
      allowedImages: [DEFAULT_HEALTH_IMAGE],
      timeoutMs: 1000,
    }).run({ repository, revision, command: "sleep 30" });
    expect(result.status).toBe("ERROR");
    expect(dockerHealthContainers()).toEqual(before);
  });

  it.skipIf(!dockerImageAvailable)("kills and removes a container when aborted", async () => {
    const before = dockerHealthContainers();
    const { repository, revision } = await makeRepo();
    const controller = new AbortController();
    const running = new DockerHealthRunner({
      allowedImages: [DEFAULT_HEALTH_IMAGE],
      timeoutMs: 30_000,
    }).run({ repository, revision, command: "sleep 30", signal: controller.signal });
    await vi.waitFor(() => expect(dockerHealthContainers().length).toBeGreaterThan(before.length), {
      timeout: 5_000,
    });

    controller.abort();
    await expect(running).resolves.toMatchObject({ status: "ERROR" });
    expect(dockerHealthContainers()).toEqual(before);
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

  it("passes validated dependency-install settings to the runner", async () => {
    const run = vi.fn(async () => ({ status: "GREEN" as const, durationMs: 8, log: "ok" }));
    await db.pool.query("UPDATE rooms SET settings = $2 WHERE id = $1", [
      "room_health",
      JSON.stringify({
        health_command: "npm test",
        health_install_command: "npm ci",
        health_lockfile_paths: ["pnpm-lock.yaml", "package-lock.json"],
      }),
    ]);

    const completed = await runHealthCheck(db.pool, { run }, "room_health", 0);

    expect(run).toHaveBeenCalledWith({
      repository: "/repo.git",
      revision: "commit_health",
      command: "npm test",
      roomId: "room_health",
      dependencyInstall: {
        pool: db.pool,
        command: "npm ci",
        lockfilePaths: ["package-lock.json", "pnpm-lock.yaml"],
      },
    });
    expect(completed?.result.status).toBe("GREEN");
  });

  it("persists invalid lockfile-path settings as ERROR without running health", async () => {
    const run = vi.fn(async () => ({ status: "GREEN" as const, durationMs: 8, log: "ok" }));
    await db.pool.query("UPDATE rooms SET settings = $2 WHERE id = $1", [
      "room_health",
      JSON.stringify({
        health_command: "npm test",
        health_install_command: "npm ci",
        health_lockfile_paths: Array.from({ length: 11 }, (_, index) => `${index}.lock`),
      }),
    ]);

    const completed = await runHealthCheck(db.pool, { run }, "room_health", 0);

    expect(run).not.toHaveBeenCalled();
    expect(completed?.result.status).toBe("ERROR");
    expect(completed?.result.log).toMatch(/at most 10/);
  });

  it("does not persist a health result when its run is aborted", async () => {
    await db.pool.query("UPDATE rooms SET settings = $2 WHERE id = $1", [
      "room_health",
      JSON.stringify({ health_command: "pnpm test" }),
    ]);
    const { rows: before } = await db.pool.query(
      "SELECT count(*)::int AS count FROM health_runs WHERE room_id = $1",
      ["room_health"],
    );
    const controller = new AbortController();
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => (started = resolve));
    const runner = {
      run: vi.fn(
        (input: { signal?: AbortSignal }) =>
          new Promise<{ status: "ERROR"; durationMs: number; log: string }>((resolve) => {
            input.signal?.addEventListener(
              "abort",
              () => resolve({ status: "ERROR", durationMs: 1, log: "aborted" }),
              { once: true },
            );
            started();
          }),
      ),
    };

    const check = runHealthCheck(db.pool, runner, "room_health", 0, controller.signal);
    await runStarted;
    controller.abort();
    await expect(check).resolves.toBeNull();
    const { rows: after } = await db.pool.query(
      "SELECT count(*)::int AS count FROM health_runs WHERE room_id = $1",
      ["room_health"],
    );
    expect(after[0]?.count).toBe(before[0]?.count);
  });
});

describe("hashHealthLockfiles", () => {
  it("keys the selected lockfile contents independent of input order", async () => {
    const { repository, revision } = await makeRepo();
    const commit = async (message: string): Promise<string> => {
      await git(["add", "--all"], { cwd: repository, timeoutMs: 10_000 });
      await git(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--quiet",
          "-m",
          message,
        ],
        { cwd: repository, timeoutMs: 10_000 },
      );
      return (
        await git(["rev-parse", "HEAD"], { cwd: repository, timeoutMs: 10_000 })
      ).stdout.trim();
    };
    const initial = await hashHealthLockfiles(repository, revision, [
      "package-lock.json",
      "pnpm-lock.yaml",
    ]);
    await writeFile(join(repository, "package-lock.json"), '{"lock":1}\n');
    const firstRevision = await commit("add package lock");
    const first = await hashHealthLockfiles(repository, firstRevision, [
      "package-lock.json",
      "pnpm-lock.yaml",
    ]);
    const reordered = await hashHealthLockfiles(repository, firstRevision, [
      "pnpm-lock.yaml",
      "package-lock.json",
      "package-lock.json",
    ]);
    await writeFile(join(repository, "package-lock.json"), '{"lock":2}\n');
    const secondRevision = await commit("update package lock");
    const second = await hashHealthLockfiles(repository, secondRevision, [
      "package-lock.json",
      "pnpm-lock.yaml",
    ]);

    expect(first).not.toBe(initial);
    expect(reordered).toBe(first);
    expect(second).not.toBe(first);
  });

  it("reads symlink lockfiles from the Git tree without following them on the host", async () => {
    const { repository } = await makeRepo();
    await symlink("/path/that/must/not/be/read", join(repository, "package-lock.json"));
    await git(["add", "package-lock.json"], { cwd: repository, timeoutMs: 10_000 });
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "add symlink lockfile",
      ],
      { cwd: repository, timeoutMs: 10_000 },
    );
    const revision = (
      await git(["rev-parse", "HEAD"], { cwd: repository, timeoutMs: 10_000 })
    ).stdout.trim();

    await expect(hashHealthLockfiles(repository, revision, ["package-lock.json"])).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("rejects paths outside the repository", async () => {
    const { repository, revision } = await makeRepo();

    await expect(hashHealthLockfiles(repository, revision, ["../outside.lock"])).rejects.toThrow(
      /parent segment/,
    );
  });

  it("ignores missing configured files and enforces the room setting limit", async () => {
    const { repository, revision } = await makeRepo();
    const absentA = await hashHealthLockfiles(repository, revision, ["absent-a.lock"]);
    const absentB = await hashHealthLockfiles(repository, revision, ["absent-b.lock"]);

    expect(absentA).toBe(absentB);
    expect(normalizeHealthLockfilePaths(undefined)).toEqual(
      [...DEFAULT_HEALTH_LOCKFILE_PATHS].sort(),
    );
    expect(() =>
      normalizeHealthLockfilePaths(Array.from({ length: 11 }, (_, index) => `${index}.lock`)),
    ).toThrow(/at most 10/);
  });
});
