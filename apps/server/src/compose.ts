import { createPool, type Pool } from "@crossover/db";
import { buildGateway } from "@crossover/gateway";
import { registerMcp } from "@crossover/mcp";
import { buildInternalGitServer } from "./internal-git.js";
import {
  Dispatcher,
  RedisBudgetLimiter,
  type BudgetLimiter,
  LeaseRenewer,
  LeaseSweeper,
  RedisEventPublisher,
  RedisEventSubscriber,
  registerRoomEventsSubscribeCommand,
  registerCapabilityCommands,
  registerDecisionCommands,
  registerDecisionDecideCommands,
  registerApprovalCommands,
  registerWakeSecretCommand,
  WakeWebhookService,
  registerInboxCommands,
  registerInviteCommands,
  registerJoinCommand,
  registerLeadCommands,
  registerMemoryAccessCommands,
  registerMemoryCommands,
  registerMessageCommands,
  registerParticipantLifecycleCommands,
  registerParticipantManifestCommand,
  registerParticipantRoleCommand,
  registerPresenceIntentCommands,
  registerRoomCommands,
  registerRoomDigestCommand,
  registerEventsRedactCommand,
  registerRoomEventsCommand,
  registerRoomLifecycleCommands,
  registerTaskCommands,
  registerTaskHeartbeat,
  registerTaskLifecycleCommands,
  registerTaskReadCommands,
  type Authorizer,
  type EventPublisher,
  type EventSubscriber,
  RedisEditIntentStore,
} from "@crossover/kernel";
import { postWebhook } from "@crossover/security";
import { authorize } from "@crossover/policy";
import {
  ConflictEscalationSweeper,
  DockerExecutionDriver,
  DockerHealthRunner,
  ExecutionService,
  HealthCheckQueue,
  workspaceHealthGate,
  provisionWorkspace,
  reconcileRef,
  registerWorkspaceCommands,
  runHealthCheck,
  publishHealthResult,
  normalizePath,
  type ExecutionDriver,
  type UpstreamDeps,
} from "@crossover/workspace";
import type { ServerConfig } from "./config.js";

export interface ComposeOverrides {
  /** Use this pool instead of opening one from `databaseUrl`; it is then not closed by `close()`. */
  pool?: Pool;
  /** Use this publisher instead of Redis at `redisUrl` (tests); it is then not closed by `close()`. */
  publisher?: EventPublisher;
  /** Use this subscriber for WebSocket streams instead of Redis at `redisUrl` (tests); not closed by `close()`. */
  subscriber?: EventSubscriber;
  /** Defaults to the real policy (T208). Tests must not pass `allowAll` to production paths. */
  authorize?: Authorizer;
  /** Lease TTL; the renewal interval is a third of it. Default: the kernel's. */
  leaseTtlMs?: number;
  /** How often agents' lapsed task claims are swept back to OPEN. Default 30 s. */
  leaseSweepIntervalMs?: number;
  /** Sandbox runtime seam for lifecycle tests; production uses the Docker driver. */
  executionDriver?: ExecutionDriver;
  /** Use this limiter for agents' budgets (§22.3) instead of Redis at `redisUrl` (tests); not closed by `close()`. */
  budgets?: BudgetLimiter;
  /** How `git.import` reaches an upstream (fetcher, credentials, host check); production: HTTPS clone, no credentials. */
  upstream?: UpstreamDeps;
}

export interface CrossoverServer {
  app: ReturnType<typeof buildGateway>;
  /** Separate Git-only Fastify server; never mounted on the public gateway. */
  gitApp: ReturnType<typeof buildInternalGitServer>;
  dispatcher: Dispatcher;
  pool: Pool;
  execution: ExecutionService;
  renewer: LeaseRenewer;
  /** Graceful shutdown (§19): stop renewing, stop serving, release every lease, close what we opened. */
  close(): Promise<void>;
}

/**
 * The composition root (T712): one dispatcher with the real policy and every command module,
 * behind the REST gateway.
 *
 * - **Room creation** provisions the room's workspace in the same transaction (T512).
 * - **Lease acquisition** (first use, failover, a lapsed lease) runs `reconcileRef` before the
 *   room's first command: PostgreSQL is authoritative over the Git ref (§19.4, ENGINEERING).
 * - **Leases** are renewed in the background while rooms are idle (T713).
 * - **Events** of every committed command are published to Redis (§19.2); the events table
 *   stays the outbox, so a Redis outage never fails a command.
 *
 * Nothing listens on a port here; {@link CrossoverServer.app} is ready for `listen()` or
 * `inject()`.
 */
export async function composeServer(
  config: ServerConfig,
  overrides: ComposeOverrides = {},
): Promise<CrossoverServer> {
  const pool = overrides.pool ?? createPool(config.databaseUrl);
  let publisher: EventPublisher;
  let redis: RedisEventPublisher | undefined;
  let escalations: ConflictEscalationSweeper | undefined;
  let leaseSweeper: LeaseSweeper | undefined;
  let wakeWebhooks: WakeWebhookService | undefined;
  let executionService: ExecutionService | undefined;
  let gitApp: ReturnType<typeof buildInternalGitServer> | undefined;
  let healthInstallSweepTimer: NodeJS.Timeout | undefined;
  if (overrides.publisher) {
    publisher = overrides.publisher;
  } else {
    redis = new RedisEventPublisher(config.redisUrl);
    publisher = redis;
  }

  let redisSubscriber: RedisEventSubscriber | undefined;
  let subscriber: EventSubscriber;
  if (overrides.subscriber) {
    subscriber = overrides.subscriber;
  } else {
    redisSubscriber = new RedisEventSubscriber(config.redisUrl);
    subscriber = redisSubscriber;
  }

  const intentStore = new RedisEditIntentStore(config.redisUrl);
  const ownBudgets = overrides.budgets ? undefined : new RedisBudgetLimiter(config.redisUrl);
  const budgets = overrides.budgets ?? ownBudgets!;

  try {
    if (redis) await redis.ready();
    await intentStore.ready();
    await ownBudgets?.ready();

    const executionDriver =
      overrides.executionDriver ??
      new DockerExecutionDriver({
        ...(config.sandboxVolumeDriver ? { volumeDriver: config.sandboxVolumeDriver } : {}),
        volumeOptions: config.sandboxVolumeOptions ?? {},
        ...(config.sandboxRuntime ? { runtime: config.sandboxRuntime } : {}),
        ...(config.sandboxEgressProxyContainer
          ? { egressProxyContainer: config.sandboxEgressProxyContainer }
          : {}),
        ...(config.sandboxEgressProxyPort !== undefined
          ? { egressProxyPort: config.sandboxEgressProxyPort }
          : {}),
        ...(config.sandboxEgressProxySecret
          ? { egressProxySecret: config.sandboxEgressProxySecret }
          : {}),
        ...(config.gitInternalContainer
          ? { gitInternalContainer: config.gitInternalContainer }
          : {}),
        gitInternalPort: config.gitInternalPort ?? 8081,
        ...(config.gitInternalTokenSecret
          ? { gitInternalTokenSecret: config.gitInternalTokenSecret }
          : {}),
        gitFetcherImage: config.gitFetcherImage ?? "crossover-git-fetcher:latest",
      });
    executionService = new ExecutionService(pool, executionDriver, {
      diskEnforcement: config.sandboxDiskEnforcement ?? "soft",
    });
    executionService.startSweeper();

    const dispatcher = new Dispatcher({
      pool,
      authorize: overrides.authorize ?? authorize,
      nodeId: config.nodeId,
      publisher,
      budgets,
      onLeaseAcquire: (roomId) => reconcileRef(pool, roomId),
      ...(overrides.leaseTtlMs !== undefined ? { leaseTtlMs: overrides.leaseTtlMs } : {}),
    });
    const healthRunner = new DockerHealthRunner({
      allowedImages: config.healthImages,
      nodeId: config.nodeId,
      ...(config.sandboxRuntime ? { runtime: config.sandboxRuntime } : {}),
      ...(config.sandboxEgressProxyContainer
        ? { egressProxyContainer: config.sandboxEgressProxyContainer }
        : {}),
      ...(config.sandboxEgressProxyPort !== undefined
        ? { egressProxyPort: config.sandboxEgressProxyPort }
        : {}),
      ...(config.sandboxEgressProxySecret
        ? { egressProxySecret: config.sandboxEgressProxySecret }
        : {}),
    });
    if (config.sandboxEgressProxyContainer) {
      healthInstallSweepTimer = setInterval(() => {
        void healthRunner.sweepExpiredInstallRuns(pool).catch((error: unknown) => {
          process.emitWarning(
            error instanceof Error ? error : new Error(String(error)),
            "HealthInstallSweepWarning",
          );
        });
      }, 60_000);
      healthInstallSweepTimer.unref();
      void healthRunner.sweepExpiredInstallRuns(pool).catch((error: unknown) => {
        process.emitWarning(
          error instanceof Error ? error : new Error(String(error)),
          "HealthInstallSweepWarning",
        );
      });
    }
    const healthQueue = new HealthCheckQueue({
      run: async (roomId, revision, signal) => {
        const outcome = await runHealthCheck(pool, healthRunner, roomId, revision, signal);
        if (outcome && !signal.aborted)
          await publishHealthResult(pool, dispatcher, roomId, revision, outcome.id, outcome.result);
      },
    });
    registerCommands(
      dispatcher,
      config,
      healthQueue,
      intentStore,
      executionService,
      overrides.upstream,
    );

    const renewer = new LeaseRenewer({ leases: dispatcher.leases, actors: dispatcher.actors });
    renewer.start();
    escalations = new ConflictEscalationSweeper({ pool, dispatcher });
    escalations.start();
    leaseSweeper = new LeaseSweeper({
      pool,
      dispatcher,
      ...(overrides.leaseSweepIntervalMs !== undefined
        ? { intervalMs: overrides.leaseSweepIntervalMs }
        : {}),
    });
    leaseSweeper.start();
    if (config.wakeWebhookKey) {
      wakeWebhooks = new WakeWebhookService({
        pool,
        key: config.wakeWebhookKey,
        sender: (request) => postWebhook(request),
      });
      wakeWebhooks.start();
    }

    const app = buildGateway({
      dispatcher,
      pool,
      devLogin: config.devLogin,
      ...(config.webRoot ? { staticRoot: config.webRoot } : {}),
      ws: { subscriber },
    });
    gitApp = buildInternalGitServer({
      pool,
      authorize: overrides.authorize ?? authorize,
      ...(config.gitInternalTokenSecret ? { tokenSecret: config.gitInternalTokenSecret } : {}),
    });
    registerMcp(app, { dispatcher, pool }); // POST /mcp, the agents' tool surface

    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        await escalations?.stop();
        await leaseSweeper?.stop();
        if (healthInstallSweepTimer) clearInterval(healthInstallSweepTimer);
        await wakeWebhooks?.stop();
        await executionService?.close();
        await renewer.stop();
        await gitApp?.close();
        await app.close();
        await healthQueue.close();
        await renewer.close(); // releases every lease once nothing can take a new one
        await redis?.close();
        await redisSubscriber?.close();
        await intentStore.close();
        await ownBudgets?.close();
        if (!overrides.pool) await pool.end();
      })());

    return { app, gitApp, dispatcher, pool, execution: executionService, renewer, close };
  } catch (err) {
    await escalations?.stop();
    await leaseSweeper?.stop();
    if (healthInstallSweepTimer) clearInterval(healthInstallSweepTimer);
    await wakeWebhooks?.stop();
    await executionService?.close();
    await gitApp?.close();
    await redis?.close();
    await redisSubscriber?.close();
    await intentStore.close();
    await ownBudgets?.close();
    if (!overrides.pool) await pool.end();
    throw err;
  }
}

/** Every command module merged so far. Each new module is registered here, once. */
function registerCommands(
  dispatcher: Dispatcher,
  config: ServerConfig,
  healthQueue: HealthCheckQueue,
  intentStore: RedisEditIntentStore,
  execution: ExecutionService,
  upstream?: UpstreamDeps,
): void {
  registerRoomCommands(dispatcher, {
    provision: async ({ client, room_id }) => {
      await provisionWorkspace(client, room_id, config.workspaceRoot);
    },
  });
  registerInviteCommands(dispatcher);
  registerJoinCommand(dispatcher);
  registerCapabilityCommands(dispatcher);
  registerParticipantRoleCommand(dispatcher);
  registerParticipantManifestCommand(dispatcher);
  registerParticipantLifecycleCommands(dispatcher, {
    afterRemove: ({ room_id, participant_id }) =>
      execution.destroyParticipant(room_id, participant_id),
  });
  registerLeadCommands(dispatcher);
  registerRoomLifecycleCommands(dispatcher, {
    afterChange: ({ room_id, to }) => {
      if (to === "PAUSED") return execution.hibernateRoom(room_id, true);
      if (to === "ARCHIVED") return execution.destroyRoom(room_id);
    },
  });
  registerRoomEventsCommand(dispatcher);
  registerEventsRedactCommand(dispatcher);
  registerRoomDigestCommand(dispatcher);
  registerInboxCommands(dispatcher);
  registerApprovalCommands(dispatcher);
  registerWakeSecretCommand(dispatcher, config.wakeWebhookKey);
  registerPresenceIntentCommands(dispatcher, intentStore, normalizePath);
  registerRoomEventsSubscribeCommand(dispatcher); // the WebSocket `subscribe` frame

  // Tasks: create/update, list/get, and the claim → start → block lifecycle.
  registerTaskCommands(dispatcher);
  registerTaskReadCommands(dispatcher);
  registerTaskLifecycleCommands(dispatcher, { healthGate: workspaceHealthGate });
  registerTaskHeartbeat(dispatcher);
  registerMessageCommands(dispatcher);
  registerMemoryCommands(dispatcher);
  registerMemoryAccessCommands(dispatcher);
  registerDecisionCommands(dispatcher);
  registerDecisionDecideCommands(dispatcher);

  // apply_changeset plus reads; schedule health for every committed revision.
  registerWorkspaceCommands(dispatcher, {
    scheduleHealthCheck: (roomId, revision) => healthQueue.enqueue(roomId, revision),
    ...(upstream ? { upstream } : {}),
  });
}
