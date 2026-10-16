import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { newId } from "@crossover/protocol";
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
const skipDockerIntegration = !dockerImageAvailable && !process.env["CI"];

function dockerHealthContainers(command: string): string[] {
  const commandHash = createHash("sha256").update(command).digest("hex");
  const output = execFileSync(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      "label=crossover.health.runner=true",
      "--filter",
      `label=crossover.health.command=${commandHash}`,
    ],
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

function fakeInstallDocker(
  installExitCode = 0,
  installOutput?: string | ((args: readonly string[]) => string),
) {
  const volumes = new Map<string, { room: string; key: string; install: string }>();
  const unlabeledVolumes = new Set<string>();
  let installs = 0;
  let healthRuns = 0;
  let failVolumeList = false;
  let failContainerList = false;
  const failVolumeRemovals = new Set<string>();
  const calls: string[][] = [];
  // `docker create` registers the container; `docker start` produces its result (T1517).
  const created = new Map<string, { code: number; output: string }>();
  const invoke = vi.fn(async (_binary: string, args: readonly string[]) => {
    calls.push([...args]);
    if (args[0] === "start") {
      const result = created.get(args.at(-1)!);
      return result
        ? { code: result.code, timedOut: false, output: result.output }
        : { code: 1, timedOut: false, output: "no such container" };
    }
    if (args[0] === "container" && args[1] === "ls") {
      if (failContainerList) {
        failContainerList = false;
        return { code: 1, timedOut: false, output: "temporary docker ls failure" };
      }
      return { code: 0, timedOut: false, output: "" };
    }
    if (args[0] === "network" && args[1] === "ls") return { code: 0, timedOut: false, output: "" };
    if (args[0] === "volume" && args[1] === "inspect") {
      const name = args.at(-1)!;
      const labels = volumes.get(name);
      if (args.includes("--format")) {
        return {
          code: labels || unlabeledVolumes.has(name) ? 0 : 1,
          timedOut: false,
          output: labels
            ? JSON.stringify({
                "crossover.health.cache": "true",
                "crossover.health.cache_room": labels.room,
                "crossover.health.cache_key": labels.key,
                "crossover.health.cache_install": labels.install,
              })
            : unlabeledVolumes.has(name)
              ? "{}"
              : `Error response from daemon: get ${name}: no such volume`,
        };
      }
      const exists = volumes.has(name) || unlabeledVolumes.has(name);
      return {
        code: exists ? 0 : 1,
        timedOut: false,
        output: exists ? "" : `Error response from daemon: get ${name}: no such volume`,
      };
    }
    if (args[0] === "volume" && args[1] === "create") {
      const name = args.at(-1)!;
      const room = args
        .find((arg) => arg.startsWith("crossover.health.cache_room="))
        ?.split("=")[1];
      const key = args.find((arg) => arg.startsWith("crossover.health.cache_key="))?.split("=")[1];
      const install = args
        .find((arg) => arg.startsWith("crossover.health.cache_install="))
        ?.split("=")[1];
      unlabeledVolumes.delete(name);
      volumes.set(name, { room: room!, key: key!, install: install! });
      return { code: 0, timedOut: false, output: name };
    }
    if (args[0] === "volume" && args[1] === "rm") {
      const name = args[2]!;
      if (failVolumeRemovals.has(name))
        return { code: 1, timedOut: false, output: "volume is in use" };
      const removed = volumes.delete(name) || unlabeledVolumes.delete(name);
      return {
        code: removed ? 0 : 1,
        timedOut: false,
        output: removed ? args[2]! : `Error response from daemon: get ${args[2]}: no such volume`,
      };
    }
    if (args[0] === "volume" && args[1] === "ls") {
      if (failVolumeList)
        return { code: 1, timedOut: false, output: "temporary volume ls failure" };
      const room = args
        .find((arg) => arg.startsWith("label=crossover.health.cache_room="))
        ?.split("=")[2];
      const output = [...volumes]
        .filter(([, labels]) => labels.room === room)
        .map(([name, labels]) => `${name}|${labels.key}|${labels.install}`)
        .join("\n");
      return { code: 0, timedOut: false, output };
    }
    if (args[0] === "run" && args.includes("--user=0:0"))
      return { code: 0, timedOut: false, output: "" };
    if (args[0] === "create" && args.includes("crossover.health.install=true")) {
      installs++;
      expect(args.some((arg) => arg.startsWith("--network=crossover-health-install-"))).toBe(true);
      expect(args.some((arg) => arg.startsWith("HTTPS_PROXY=http://"))).toBe(true);
      created.set(args[args.indexOf("--name") + 1]!, {
        code: installExitCode,
        output:
          typeof installOutput === "function"
            ? installOutput(args)
            : (installOutput ?? (installExitCode === 0 ? "install ok" : "registry refused")),
      });
      return { code: 0, timedOut: false, output: "container-id" };
    }
    if (args[0] === "create" && args.includes("crossover.health.runner=true")) {
      healthRuns++;
      created.set(args[args.indexOf("--name") + 1]!, { code: 0, output: "health ok" });
      return { code: 0, timedOut: false, output: "container-id" };
    }
    return { code: 0, timedOut: false, output: "" };
  });
  return {
    invoke,
    calls,
    installCount: () => installs,
    healthCount: () => healthRuns,
    cacheVolumes: () => [...volumes.keys()],
    setVolumeListFailure: (value: boolean) => {
      failVolumeList = value;
    },
    failVolumeRemoval: (name: string) => {
      failVolumeRemovals.add(name);
    },
    makeVolumeUnlabeled: (name: string) => {
      volumes.delete(name);
      unlabeledVolumes.add(name);
    },
    failNextContainerList: () => {
      failContainerList = true;
    },
    seedCacheVolume: (name: string, labels: { room: string; key: string; install: string }) => {
      volumes.set(name, labels);
    },
  };
}

async function commitHealthFixture(repository: string, message: string): Promise<string> {
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
  return (await git(["rev-parse", "HEAD"], { cwd: repository, timeoutMs: 10_000 })).stdout.trim();
}

async function makeLockedHealthRepo(): Promise<{ repository: string; revision: string }> {
  const { repository } = await makeRepo();
  await writeFile(join(repository, "package-lock.json"), "{}\n");
  return { repository, revision: await commitHealthFixture(repository, "add lockfile") };
}

function makeDependencyHealthRun(docker: ReturnType<typeof fakeInstallDocker>) {
  const runner = new DockerHealthRunner(
    {
      egressProxyContainer: "egress-proxy",
      egressProxySecret: "0123456789abcdef0123456789abcdef",
    },
    docker.invoke,
  );
  return (repository: string, revision: string) =>
    runner.run({
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
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * Real containers under a loaded full suite need more than vitest's 5 s default (T1517). S2
 * measured the abort case at 2.9 s in isolation; it timed out at 5 s in #248's CI run.
 */
const DOCKER_CASE_TIMEOUT_MS = 30_000;

describe("DockerHealthRunner", () => {
  it("creates Docker health checkouts under the configured host-visible root", async () => {
    const { repository, revision } = await makeRepo();
    const checkoutRoot = await mkdtemp(join(tmpdir(), "crossover-health-root-"));
    directories.push(checkoutRoot);
    let volume = "";
    const invoke = vi.fn(async (_binary: string, args: readonly string[]) => {
      if (args[0] === "create") volume = args[args.indexOf("--volume") + 1]!;
      return {
        code: 0,
        timedOut: false,
        output: args[0] === "create" ? "container-id" : "",
      };
    });
    const runner = new DockerHealthRunner({ checkoutRoot }, invoke);

    await runner.run({ repository, revision, command: "npm test" });

    expect(volume.startsWith(`${checkoutRoot}/crossover-health-`)).toBe(true);
    expect(volume.endsWith(":/workspace:rw")).toBe(true);
  });

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
        if (args[0] === "start") {
          if (timedOut) await options?.onTimeout?.();
          return { code, timedOut, output: "runner output" };
        }
        if (args[0] !== "create") return { code: 0, timedOut: false, output: "" };
        const volume = args[args.indexOf("--volume") + 1]!;
        const checkout = volume.slice(0, volume.lastIndexOf(":/workspace:rw"));
        checkedOutText = await readFile(join(checkout, "sentinel.txt"), "utf8");
        return { code: 0, timedOut: false, output: "container-id" };
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
      timedOut ? ["create", "start", "kill", "rm"] : ["create", "start", "rm"],
    );
  });

  /**
   * A Docker daemon whose `create` stays in flight until the test lets it finish (T1517), with no
   * clock involved: `createStarted` resolves when a create request arrives, `finishCreate()`
   * makes the container exist and answers the request. A container exists exactly from the
   * moment its create completes, as in Docker, and `rm` removes it.
   */
  function controlledDaemon() {
    const containers = new Set<string>();
    const calls: string[] = [];
    let startCreate!: () => void;
    let finishCreate!: () => void;
    const createStarted = new Promise<void>((resolve) => (startCreate = resolve));
    const createGate = new Promise<void>((resolve) => (finishCreate = resolve));
    const nameOf = (args: readonly string[]) => args[args.indexOf("--name") + 1]!;
    const invoke = vi.fn(async (_binary: string, args: readonly string[]) => {
      calls.push(args[0]!);
      if (args[0] === "create") {
        startCreate();
        await createGate; // still creating
        containers.add(nameOf(args));
      } else if (args[0] === "rm") {
        containers.delete(args.at(-1)!);
      } else if (args[0] === "start") {
        return { code: 1, timedOut: false, output: "start must not be called after an abort" };
      }
      return { code: 0, timedOut: false, output: "" };
    });
    return { invoke, calls, containers, createStarted, finishCreate: () => finishCreate() };
  }

  it("leaves no container when aborted while the daemon is still creating it (T1517)", async () => {
    const { repository, revision } = await makeRepo();
    const daemon = controlledDaemon();
    const controller = new AbortController();

    const running = new DockerHealthRunner({}, daemon.invoke).run({
      repository,
      revision,
      command: "sleep 30",
      signal: controller.signal,
    });
    await daemon.createStarted;
    controller.abort(); // the abort arrives while the create request is in flight
    daemon.finishCreate(); // and the daemon completes that create anyway
    const result = await running;

    expect(result.status).toBe("ERROR");
    expect([...daemon.containers]).toEqual([]);
    expect(daemon.calls).toEqual(["create", "rm"]); // never started; removed once it existed
  });

  it("leaves no install container when aborted while the daemon is still creating it (T1517)", async () => {
    await db.pool.query("DELETE FROM health_install_runs WHERE room_id = $1", ["room_health"]);
    const { repository, revision } = await makeLockedHealthRepo();
    const docker = fakeInstallDocker();
    const daemon = controlledDaemon();
    const controller = new AbortController();
    const forDaemon = (args: readonly string[]) =>
      args[0] === "create"
        ? args.includes("crossover.health.install=true")
        : ["start", "rm"].includes(args[0]!) && args.at(-1)!.startsWith("health-install");
    const invoke = vi.fn(async (binary: string, args: readonly string[]) =>
      forDaemon(args) ? daemon.invoke(binary, args) : docker.invoke(binary, args),
    );

    const running = new DockerHealthRunner(
      {
        egressProxyContainer: "egress-proxy",
        egressProxySecret: "0123456789abcdef0123456789abcdef",
      },
      invoke,
    ).run({
      repository,
      revision,
      roomId: "room_health",
      command: "npm test",
      signal: controller.signal,
      dependencyInstall: { pool: db.pool, command: "npm ci", lockfilePaths: ["package-lock.json"] },
    });
    await daemon.createStarted;
    controller.abort();
    daemon.finishCreate();
    const result = await running;

    expect(result.status).toBe("ERROR");
    expect([...daemon.containers]).toEqual([]);
    expect(daemon.calls).toEqual(["create", "rm"]);
  });

  it("returns only once a container the daemon is auto-removing is gone (T1517)", async () => {
    const { repository, revision } = await makeRepo();
    // After the kill the daemon removes the --rm container itself and is still at it for the
    // first two looks; `docker rm -f` meanwhile fails with "removal already in progress" and the
    // container is still listed. This is what CI saw 1.5 s into the real timeout case (run
    // 38354265644). The removal progresses with the looks, not with a clock.
    let looks = 0;
    const listed = () => looks < 2;
    const invoke = vi.fn(
      async (
        _binary: string,
        args: readonly string[],
        options?: { onTimeout?: () => Promise<void> },
      ) => {
        if (args[0] === "start") {
          await options?.onTimeout?.();
          return { code: null, timedOut: true, output: "" };
        }
        if (args[0] === "rm" && listed())
          return {
            code: 1,
            timedOut: false,
            output: "removal of container is already in progress",
          };
        if (args[0] === "ps") {
          const output = listed() ? "abc123" : "";
          looks++;
          return { code: 0, timedOut: false, output };
        }
        return { code: 0, timedOut: false, output: "" };
      },
    );

    const result = await new DockerHealthRunner({ timeoutMs: 50 }, invoke).run({
      repository,
      revision,
      command: "sleep 30",
    });

    expect(result.status).toBe("ERROR");
    expect(listed()).toBe(false); // gone by the time run() returns
    expect(looks).toBe(3); // two looks while it was still being removed, one that found it gone
  });

  it("validates runner configuration", () => {
    expect(() => new DockerHealthRunner({ image: "  " })).toThrow(/allowlist/);
    expect(() => new DockerHealthRunner({ allowedImages: [] })).toThrow(/allowlist/);
    expect(() => new DockerHealthRunner({ timeoutMs: 0 })).toThrow(/timeout/);
    expect(() => new DockerHealthRunner({ egressProxyContainer: "proxy" })).toThrow(/SECRET/);
    expect(() => new DockerHealthRunner({ runtime: " " })).toThrow(/SANDBOX_RUNTIME/);
  });

  it("passes the configured runtime to health containers", async () => {
    const { repository, revision } = await makeRepo();
    const invoke = vi.fn(async (_binary: string, _args: readonly string[]) => ({
      code: 0,
      timedOut: false,
      output: "ok",
    }));
    const result = await new DockerHealthRunner({ runtime: "runsc" }, invoke).run({
      repository,
      revision,
      command: "true",
    });
    expect(result.status).toBe("GREEN");
    expect(invoke.mock.calls[0]?.[1]).toContain("--runtime");
    expect(invoke.mock.calls[0]?.[1]).toContain("runsc");
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

  // Measured (T1529): idle 1203 ms, 3x load 2586 ms; budget 7x.
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
        runtime: "runsc",
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
    await writeFile(join(repository, "package-lock.json"), '{"lock":3}\n');
    const newestLocksRevision = await commit("update lockfile again");
    const fourth = await run(newestLocksRevision);

    expect([first.status, second.status, third.status, fourth.status]).toEqual([
      "GREEN",
      "GREEN",
      "GREEN",
      "GREEN",
    ]);
    expect(docker.installCount()).toBe(3);
    expect(docker.healthCount()).toBe(4);
    expect(
      docker.calls.filter((args) => args[0] === "network" && args[1] === "create"),
    ).toHaveLength(3);
    expect(docker.calls.filter((args) => args[0] === "network" && args[1] === "rm")).toHaveLength(
      3,
    );
    expect(docker.calls.filter((args) => args.includes("--runtime")).length).toBeGreaterThan(0);
    const cacheUid = process.getuid?.() === 0 ? 1000 : (process.getuid?.() ?? 1000);
    const cacheGid = process.getgid?.() === 0 ? 1000 : (process.getgid?.() ?? 1000);
    expect(
      docker.calls.some((args) =>
        args.some((arg) => arg.includes(`chown ${cacheUid}:${cacheGid} /health-dependency-cache`)),
      ),
    ).toBe(true);
    expect(docker.cacheVolumes()).toHaveLength(2);
    const healthArgs = docker.calls.find((args) => args.includes("crossover.health.runner=true"))!;
    const installArgs = docker.calls.find(
      (args) => args[0] === "create" && args.includes("crossover.health.install=true"),
    )!;
    const volumeInitArgs = docker.calls.find(
      (args) => args[0] === "run" && args.includes("--user=0:0"),
    )!;
    expect(installArgs[installArgs.indexOf("--runtime") + 1]).toBe("runsc");
    expect(installArgs).toContain("npm_config_cache=/tmp/npm-cache");
    expect(installArgs).toContain("GOCACHE=/tmp/go-build");
    expect(installArgs).not.toContain("PIP_CACHE_DIR=/health-dependency-cache/pip-cache");
    expect(volumeInitArgs).toEqual(
      expect.arrayContaining([
        "--network=none",
        "--cap-drop=ALL",
        "--cap-add=CHOWN",
        "--security-opt=no-new-privileges",
      ]),
    );
    expect(healthArgs).toContain("--network=none");
    expect(healthArgs.some((arg) => arg.includes("target=/workspace/node_modules,readonly"))).toBe(
      true,
    );
    const { rows } = await db.pool.query(
      "SELECT status FROM health_install_runs WHERE room_id = $1 ORDER BY started_at",
      ["room_health"],
    );
    expect(rows.map((row) => row.status)).toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
  }, 20_000);

  it("reinstalls when the selected cache volume exists without labels", async () => {
    await db.pool.query("DELETE FROM health_install_runs WHERE room_id = $1", ["room_health"]);
    const { repository } = await makeRepo();
    await writeFile(join(repository, "package-lock.json"), '{"lock":1}\n');
    const revision = await commitHealthFixture(repository, "add lockfile");
    const docker = fakeInstallDocker();
    const run = makeDependencyHealthRun(docker);

    expect((await run(repository, revision)).status).toBe("GREEN");
    const priorVolume = docker.cacheVolumes()[0]!;
    // Docker can recreate a missing named volume without its original cache labels.
    docker.makeVolumeUnlabeled(priorVolume);
    expect((await run(repository, revision)).status).toBe("GREEN");

    expect(docker.installCount()).toBe(2);
    expect(docker.healthCount()).toBe(2);
    const healthCalls = docker.calls.filter((args) =>
      args.includes("crossover.health.runner=true"),
    );
    expect(healthCalls.at(-1)?.some((arg) => arg.includes(`source=${priorVolume},`))).toBe(false);
    expect(docker.cacheVolumes()).not.toContain(priorVolume);
    expect(docker.cacheVolumes()).toHaveLength(1);
  });

  // Measured (T1529): idle 2284 ms, 3x load 2795 ms; budget 7x.
  it("continues cache GC after one volume cannot be removed", async () => {
    await db.pool.query("DELETE FROM health_install_runs WHERE room_id = $1", ["room_health"]);
    const { repository } = await makeRepo();
    await writeFile(join(repository, "package-lock.json"), '{"lock":1}\n');
    const docker = fakeInstallDocker();
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = makeDependencyHealthRun(docker);

    const revisionA = await commitHealthFixture(repository, "lock A");
    expect((await run(repository, revisionA)).status).toBe("GREEN");
    const volumeA = docker.cacheVolumes()[0]!;
    await writeFile(join(repository, "package-lock.json"), '{"lock":2}\n');
    const revisionB = await commitHealthFixture(repository, "lock B");
    expect((await run(repository, revisionB)).status).toBe("GREEN");
    const volumeB = docker.cacheVolumes().find((name) => name !== volumeA)!;
    docker.failVolumeRemoval(volumeA);
    await writeFile(join(repository, "package-lock.json"), '{"lock":3}\n');
    const revisionC = await commitHealthFixture(repository, "lock C");
    expect((await run(repository, revisionC)).status).toBe("GREEN");
    await writeFile(join(repository, "package-lock.json"), '{"lock":4}\n');
    const revisionD = await commitHealthFixture(repository, "lock D");
    expect((await run(repository, revisionD)).status).toBe("GREEN");

    expect(docker.cacheVolumes()).toContain(volumeA);
    expect(docker.cacheVolumes()).not.toContain(volumeB);
    expect(docker.cacheVolumes()).toHaveLength(3);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("failed to remove dependency cache volume"),
      expect.any(Error),
    );
  }, 20_000);

  it("does not mount a leftover volume from a failed reinstall", async () => {
    await db.pool.query("DELETE FROM health_install_runs WHERE room_id = $1", ["room_health"]);
    const { repository } = await makeRepo();
    await writeFile(join(repository, "package-lock.json"), '{"lock":1}\n');
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
    const lockfileHash = await hashHealthLockfiles(repository, revision, ["package-lock.json"]);
    const cacheKey = createHash("sha256")
      .update(
        JSON.stringify({ lockfileHash, installCommand: "npm ci", image: DEFAULT_HEALTH_IMAGE }),
      )
      .digest("hex");
    const priorSuccessId = newId("hinstall");
    const abandonedInstallId = newId("hinstall");
    await db.pool.query(
      `INSERT INTO health_install_runs (id, room_id, cache_key, status, started_at, expires_at, finished_at)
       VALUES ($1, 'room_health', $3, 'SUCCEEDED', clock_timestamp() - interval '5 minutes',
               clock_timestamp() - interval '4 minutes', clock_timestamp() - interval '4 minutes'),
              ($2, 'room_health', $3, 'FAILED', clock_timestamp() - interval '2 minutes',
               clock_timestamp() + interval '8 minutes', clock_timestamp() - interval '1 minute')`,
      [priorSuccessId, abandonedInstallId, cacheKey],
    );
    const roomLabel = createHash("sha256").update("room_health").digest("hex").slice(0, 24);
    const leftoverVolume = `crossover-health-cache-${roomLabel}-${cacheKey}-${abandonedInstallId}`;
    const docker = fakeInstallDocker();
    docker.seedCacheVolume(leftoverVolume, {
      room: roomLabel,
      key: cacheKey,
      install: abandonedInstallId,
    });
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

    expect(result.status).toBe("GREEN");
    expect(docker.installCount()).toBe(1);
    expect(docker.healthCount()).toBe(1);
    const healthArgs = docker.calls.find((args) => args.includes("crossover.health.runner=true"))!;
    expect(healthArgs.some((arg) => arg.includes(`source=${leftoverVolume},`))).toBe(false);
    expect(docker.cacheVolumes()).not.toContain(leftoverVolume);
    const { rows } = await db.pool.query(
      "SELECT status FROM health_install_runs WHERE room_id = $1 ORDER BY started_at",
      ["room_health"],
    );
    expect(rows.map((row) => row.status)).toEqual(["SUCCEEDED", "FAILED", "SUCCEEDED"]);
  });

  // Measured (T1529): idle 2118 ms, 3x load 4522 ms; budget 7x.
  it("keeps the selected cache across best-effort GC failures and protects it during collection", async () => {
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
    const revisionA = await commit("lock A");
    const docker = fakeInstallDocker();
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = new DockerHealthRunner(
      {
        egressProxyContainer: "egress-proxy",
        egressProxySecret: "0123456789abcdef0123456789abcdef",
      },
      docker.invoke,
    );
    const run = (revision: string) =>
      runner.run({
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

    expect((await run(revisionA)).status).toBe("GREEN");
    const { rows: firstSuccessRows } = await db.pool.query<{ id: string }>(
      "SELECT id FROM health_install_runs WHERE room_id = $1 AND status = 'SUCCEEDED' ORDER BY finished_at LIMIT 1",
      ["room_health"],
    );
    const selectedVolume = docker
      .cacheVolumes()
      .find((name) => name.endsWith(firstSuccessRows[0]!.id))!;
    docker.setVolumeListFailure(true);
    await writeFile(join(repository, "package-lock.json"), '{"lock":2}\n');
    const revisionB = await commit("lock B");
    expect((await run(revisionB)).status).toBe("GREEN");
    await writeFile(join(repository, "package-lock.json"), '{"lock":3}\n');
    const revisionC = await commit("lock C");
    expect((await run(revisionC)).status).toBe("GREEN");
    expect(docker.cacheVolumes()).toHaveLength(3);

    docker.setVolumeListFailure(false);
    expect((await run(revisionA)).status).toBe("GREEN");
    expect(docker.cacheVolumes()).toContain(selectedVolume);
    const healthCalls = docker.calls.filter((args) =>
      args.includes("crossover.health.runner=true"),
    );
    expect(healthCalls.at(-1)?.some((arg) => arg.includes(`source=${selectedVolume},`))).toBe(true);

    docker.setVolumeListFailure(true);
    expect((await run(revisionA)).status).toBe("GREEN");
    expect(docker.cacheVolumes()).toContain(selectedVolume);
    const afterGcFailureHealthCalls = docker.calls.filter((args) =>
      args.includes("crossover.health.runner=true"),
    );
    expect(
      afterGcFailureHealthCalls.at(-1)?.some((arg) => arg.includes(`source=${selectedVolume},`)),
    ).toBe(true);
    expect(docker.installCount()).toBe(3);
    expect(docker.healthCount()).toBe(5);
    expect(logError).toHaveBeenCalled();
  }, 35_000);

  it("records install failure as ERROR and skips the health command", async () => {
    await db.pool.query("DELETE FROM health_install_runs WHERE room_id = $1", ["room_health"]);
    const { repository } = await makeRepo();
    await writeFile(join(repository, "package-lock.json"), "{}\n");
    const revision = await commitHealthFixture(repository, "add lockfile");
    const leakedSecrets: string[] = [];
    const docker = fakeInstallDocker(1, (args) => {
      const proxyUrl = args
        .find((arg) => arg.startsWith("HTTPS_PROXY="))!
        .slice("HTTPS_PROXY=".length);
      const proxy = new URL(proxyUrl);
      const installId = decodeURIComponent(proxy.username);
      const credential = decodeURIComponent(proxy.password);
      const urlEncoded = encodeURIComponent(credential);
      const base64 = Buffer.from(credential).toString("base64");
      const basic = Buffer.from(`${installId}:${credential}`).toString("base64");
      leakedSecrets.push(credential, urlEncoded, base64, basic);
      return `registry refused after ${installId}:${credential}@egress-proxy:3128; encoded=${urlEncoded}; base64=${base64}; Proxy-Authorization: Basic ${basic}`;
    });
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
    for (const secret of leakedSecrets) expect(result.log).not.toContain(secret);
    expect(result.log).toContain("[REDACTED]");
    expect(docker.installCount()).toBe(1);
    expect(docker.healthCount()).toBe(0);
    expect(docker.cacheVolumes()).toHaveLength(0);
    const { rows } = await db.pool.query(
      "SELECT status FROM health_install_runs WHERE room_id = $1",
      ["room_health"],
    );
    expect(rows).toEqual([{ status: "FAILED" }]);
  });

  it("does not report success when the run row was failed before the installer completed", async () => {
    await db.pool.query("DELETE FROM health_install_runs WHERE room_id = $1", ["room_health"]);
    const { repository, revision } = await makeLockedHealthRepo();
    const docker = fakeInstallDocker();
    const invoke = vi.fn(async (binary: string, args: readonly string[]) => {
      if (args[0] === "create" && args.includes("crossover.health.install=true")) {
        await db.pool.query(
          `UPDATE health_install_runs
           SET status = 'FAILED', finished_at = clock_timestamp()
           WHERE room_id = $1 AND status = 'RUNNING'`,
          ["room_health"],
        );
      }
      return docker.invoke(binary, args);
    });
    const result = await new DockerHealthRunner(
      {
        egressProxyContainer: "egress-proxy",
        egressProxySecret: "0123456789abcdef0123456789abcdef",
      },
      invoke,
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
    expect(result.log).toContain("stopped being RUNNING");
    expect(docker.installCount()).toBe(1);
    expect(docker.healthCount()).toBe(0);
    expect(docker.cacheVolumes()).toHaveLength(0);
    const { rows } = await db.pool.query(
      "SELECT status FROM health_install_runs WHERE room_id = $1",
      ["room_health"],
    );
    expect(rows).toEqual([{ status: "FAILED" }]);
  });

  it("only fails stale installs owned by this node when its container is gone", async () => {
    const otherRoom = "room_health_node_b";
    await db.pool.query(
      `INSERT INTO rooms (id, slug, name, objective, owner_id)
       VALUES ($1, $1, 'Health node B', 'Health sweep fixture', 'owner_health')
       ON CONFLICT (id) DO NOTHING`,
      [otherRoom],
    );
    await db.pool.query("DELETE FROM health_install_runs WHERE room_id = ANY($1::text[])", [
      ["room_health", otherRoom],
    ]);
    const installId = newId("hinstall");
    const otherInstallId = newId("hinstall");
    await db.pool.query(
      `INSERT INTO health_install_runs (id, room_id, node_id, cache_key, status, started_at, expires_at)
       VALUES ($1, 'room_health', 'node-a', $3, 'RUNNING', clock_timestamp() - interval '3 minutes',
               clock_timestamp() + interval '8 minutes'),
              ($2, $4, 'node-b', $5, 'RUNNING', clock_timestamp() - interval '3 minutes',
               clock_timestamp() + interval '8 minutes')`,
      [installId, otherInstallId, "c".repeat(64), otherRoom, "d".repeat(64)],
    );
    const networkName = `crossover-health-install-${installId.slice("hinstall_".length).toLowerCase()}`;
    const invoke = vi.fn(async (_binary: string, args: readonly string[]) => ({
      code: 0,
      timedOut: false,
      output: args[0] === "network" && args[1] === "ls" ? `${networkName}|${installId}` : "",
    }));
    const runner = new DockerHealthRunner(
      {
        nodeId: "node-a",
        egressProxyContainer: "egress-proxy",
        egressProxySecret: "0123456789abcdef0123456789abcdef",
      },
      invoke,
    );

    await runner.sweepExpiredInstallRuns(db.pool);

    const { rows } = await db.pool.query<{ id: string; status: string }>(
      "SELECT id, status FROM health_install_runs WHERE id = ANY($1::text[]) ORDER BY id",
      [[installId, otherInstallId]],
    );
    expect(rows).toEqual(
      [
        { id: installId, status: "FAILED" },
        { id: otherInstallId, status: "RUNNING" },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );
    expect(invoke).toHaveBeenCalledWith(
      "docker",
      ["network", "rm", networkName],
      expect.anything(),
    );
  });

  it("continues an install after a transient Docker container-list failure", async () => {
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
    const docker = fakeInstallDocker();
    docker.failNextContainerList();
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

    expect(result.status).toBe("GREEN");
    expect(docker.installCount()).toBe(1);
    expect(docker.healthCount()).toBe(1);
  });

  it("expires a run from another node and removes its container before its network", async () => {
    await db.pool.query("DELETE FROM health_install_runs WHERE room_id = $1", ["room_health"]);
    const installId = newId("hinstall");
    await db.pool.query(
      `INSERT INTO health_install_runs (id, room_id, node_id, cache_key, status, started_at, expires_at)
       VALUES ($1, 'room_health', 'node-old', $2, 'RUNNING', clock_timestamp() - interval '3 minutes',
               clock_timestamp() - interval '1 second')`,
      [installId, "d".repeat(64)],
    );
    const suffix = installId.slice("hinstall_".length).toLowerCase();
    const calls: string[][] = [];
    const invoke = vi.fn(async (_binary: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === "container" && args[1] === "ls")
        return {
          code: 0,
          timedOut: false,
          output: `health-install-${suffix}|${installId}`,
        };
      if (args[0] === "network" && args[1] === "ls")
        return {
          code: 0,
          timedOut: false,
          output: `crossover-health-install-${suffix}|${installId}`,
        };
      return { code: 0, timedOut: false, output: "" };
    });
    const runner = new DockerHealthRunner(
      {
        nodeId: "node-new",
        egressProxyContainer: "egress-proxy",
        egressProxySecret: "0123456789abcdef0123456789abcdef",
      },
      invoke,
    );

    await runner.sweepExpiredInstallRuns(db.pool);
    expect(
      (await db.pool.query("SELECT status FROM health_install_runs WHERE id = $1", [installId]))
        .rows,
    ).toEqual([{ status: "FAILED" }]);

    const containerRemoval = calls.findIndex(
      (args) => args[0] === "container" && args[1] === "rm" && args[2] === "--force",
    );
    const networkRemoval = calls.findIndex((args) => args[0] === "network" && args[1] === "rm");
    expect(containerRemoval).toBeGreaterThanOrEqual(0);
    expect(networkRemoval).toBeGreaterThan(containerRemoval);
  });

  it.skipIf(skipDockerIntegration)(
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
    DOCKER_CASE_TIMEOUT_MS,
  );

  it.skipIf(skipDockerIntegration)(
    "blocks network access from the container",
    async () => {
      const { repository, revision } = await makeRepo();
      const result = await new DockerHealthRunner({ allowedImages: [DEFAULT_HEALTH_IMAGE] }).run({
        repository,
        revision,
        command:
          "node -e \"fetch('https://example.com',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(1),()=>process.exit(0))\"",
      });
      expect(result.status).toBe("GREEN");
    },
    DOCKER_CASE_TIMEOUT_MS,
  );

  it.skipIf(skipDockerIntegration)(
    "keeps successful status with output over 1 MiB",
    async () => {
      const { repository, revision } = await makeRepo();
      const result = await new DockerHealthRunner({ allowedImages: [DEFAULT_HEALTH_IMAGE] }).run({
        repository,
        revision,
        command: "node -e \"process.stdout.write('x'.repeat(2*1024*1024))\"",
      });
      expect(result.status).toBe("GREEN");
      expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(1024 * 1024 + 20);
    },
    DOCKER_CASE_TIMEOUT_MS,
  );

  it.skipIf(skipDockerIntegration)(
    "kills and removes a container on timeout",
    async () => {
      const command = `sleep 30; : ${randomUUID()}`;
      const before = dockerHealthContainers(command);
      const { repository, revision } = await makeRepo();
      const result = await new DockerHealthRunner({
        allowedImages: [DEFAULT_HEALTH_IMAGE],
        timeoutMs: 1000,
      }).run({ repository, revision, command });
      expect(result.status).toBe("ERROR");
      expect(dockerHealthContainers(command)).toEqual(before);
    },
    DOCKER_CASE_TIMEOUT_MS,
  );

  it.skipIf(skipDockerIntegration)(
    "kills and removes a container when aborted",
    async () => {
      const command = `sleep 30; : ${randomUUID()}`;
      const before = dockerHealthContainers(command);
      const { repository, revision } = await makeRepo();
      const controller = new AbortController();
      const running = new DockerHealthRunner({
        allowedImages: [DEFAULT_HEALTH_IMAGE],
        timeoutMs: 30_000,
      }).run({ repository, revision, command, signal: controller.signal });
      await vi.waitFor(
        () => expect(dockerHealthContainers(command).length).toBeGreaterThan(before.length),
        { timeout: 15_000 }, // container start includes the checkout; 5 s failed under local load (T1539)
      );

      controller.abort();
      await expect(running).resolves.toMatchObject({ status: "ERROR" });
      expect(dockerHealthContainers(command)).toEqual(before);
    },
    45_000,
  );

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
