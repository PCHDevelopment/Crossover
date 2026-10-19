import { createPool, withTransaction, type Pool } from "@crossover/db";
import {
  buildGateway,
  RedisOAuthStateStore,
  RedisGitHubInstallStore,
  RedisRoomExportLimiter,
  REDIS_STORE_OPTIONS,
  createRedisClient,
  type RouteRateLimiter,
  type RoomExportLimiter,
  type SandboxOutputMetadata,
  type SandboxOutputSource,
  type OAuthProvider,
} from "@crossover/gateway";
import { MCP_TOOLS, registerMcp } from "@crossover/mcp";
import { buildInternalGitServer } from "./internal-git.js";
import { registerA2aInbound } from "./a2a-inbound.js";
import { purgeRoomWorkspace } from "./purge-workspace.js";
import { githubOAuthProvider } from "./github-oauth.js";
import { googleOAuthProvider } from "./google-oauth.js";
import { IntegrationCredentialBroker } from "./integration-broker.js";
import { GitHubPullRequestProvider } from "./github-pull-request.js";
import { registerBrowserTools } from "./browser-plugin.js";
import { registerGitHubTools } from "./github-plugin.js";
import { registerAwsTools } from "./aws-plugin.js";
import {
  Dispatcher,
  filterReadablePaths,
  RedisBudgetLimiter,
  type BudgetLimiter,
  LeaseRenewer,
  LeaseSweeper,
  RoomRetentionSweeper,
  RedisEventPublisher,
  RedisEventSubscriber,
  RedisPresenceSubscriber,
  RedisEditIntentSubscriber,
  registerRoomEventsSubscribeCommand,
  registerCapabilityCommands,
  registerDecisionCommands,
  registerDecisionDecideCommands,
  registerApprovalCommands,
  registerToolCommands,
  registerIntegrationCommands,
  ToolRegistry,
  type IntegrationCommandsOptions,
  type ToolRunner,
  registerWakeSecretCommand,
  WakeWebhookService,
  registerInboxCommands,
  registerInviteCommands,
  registerJoinCommand,
  registerLeadCommands,
  registerMemoryAccessCommands,
  registerMemoryCommands,
  MemoryEmbeddingIndexer,
  HashEmbeddingProvider,
  type EmbeddingProvider,
  registerMessageCommands,
  registerParticipantLifecycleCommands,
  registerParticipantManifestCommand,
  registerParticipantRoleCommand,
  registerPresenceCommands,
  registerPresenceIntentCommands,
  registerRoomCommands,
  registerBudgetCommands,
  registerRoomDigestCommand,
  registerEventsRedactCommand,
  registerRoomEventsCommand,
  registerRoomLifecycleCommands,
  registerRoomRetentionCommands,
  registerRoomProtectedPathsCommand,
  registerRoomHealthSettingsCommand,
  registerTaskCommands,
  registerTaskHeartbeat,
  registerTaskLifecycleCommands,
  registerTaskReadCommands,
  type Authorizer,
  type Principal,
  type EventPublisher,
  type EventSubscriber,
  RedisEditIntentStore,
  RedisPresenceStore,
} from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { normalizeRoomEgressAllowlist, postWebhook } from "@crossover/security";
import { authorize, tierOf } from "@crossover/policy";
import { join } from "node:path";
import { DockerToolRunner } from "./plugin-runner.js";
import { AwsKmsDataKeyOperations, KmsRoomDataKeyProvider } from "./kms-secret-keys.js";
import { ConfigKeyRoomDataKeyProvider, EnvelopeSecretStore } from "./secret-store.js";
import { RoomExportService } from "./room-export.js";
import {
  ConflictEscalationSweeper,
  DockerExecutionDriver,
  DockerHealthRunner,
  DEFAULT_HEALTH_IMAGE,
  ExecutionService,
  HealthCheckQueue,
  workspaceHealthGate,
  provisionWorkspace,
  reconcileRef,
  githubRepositoryFromUrl,
  registerWorkspaceCommands,
  type GitCredentialProvider,
  runHealthCheck,
  publishHealthResult,
  normalizePath,
  registerSandboxStatusCommand,
  registerSandboxFileCommands,
  registerSandboxSyncCommand,
  registerSandboxSubmitCommand,
  registerSandboxExecCommands,
  FileLogStore,
  SandboxOutputHub,
  type LogStore,
  type SandboxExecLogMetadata,
  type ExecutionDriver,
  type UpstreamDeps,
  type WorkspaceCommandDeps,
  DEFAULT_GIT_INTERNAL_NETWORK,
  ConflictMetricsReporter,
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
  /** Shared clock for sandbox compute accounting and budget usage reads (tests). */
  now?: () => Date;
  /** Sandbox runtime seam for lifecycle tests; production uses the Docker driver. */
  executionDriver?: ExecutionDriver;
  /** Use this limiter for agents' budgets (§22.3) instead of Redis at `redisUrl` (tests); not closed by `close()`. */
  budgets?: BudgetLimiter;
  /** Tools plugins declare, and what runs them (the plugin runner, T1202); none by default. */
  tools?: { registry?: ToolRegistry; runner?: ToolRunner; timeoutMs?: number };
  /** Secret storage and provider verification seams for integration commands. */
  integrations?: IntegrationCommandsOptions;
  /** Room export admission limiter for gateway tests. */
  roomExportLimiter?: RoomExportLimiter;
  /** OAuth provider injection for isolated composition tests; never populated from server config. */
  oauthProviders?: Readonly<Record<string, OAuthProvider>>;
  /** How `git.import` reaches an upstream (fetcher, credentials, host check); production: HTTPS clone, no credentials. */
  upstream?: UpstreamDeps;
  /** Interval override for memory index catch-up (tests). */
  memorySweepIntervalMs?: number;
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
  const redisClient = createRedisClient(config.redisUrl, {
    ...REDIS_STORE_OPTIONS,
    connectionName: `crossover:${config.nodeId}`,
  });
  const redisSubscriberClient = createRedisClient(config.redisUrl, {
    connectionName: `crossover:${config.nodeId}`,
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  });
  const memoryProvider =
    config.memorySearchProvider === "local-hash" ? new HashEmbeddingProvider() : undefined;
  const memoryIndexer = memoryProvider
    ? new MemoryEmbeddingIndexer({
        pool,
        provider: memoryProvider,
        ...(overrides.memorySweepIntervalMs
          ? { sweepIntervalMs: overrides.memorySweepIntervalMs }
          : {}),
      })
    : undefined;
  let publisher: EventPublisher;
  let redis: RedisEventPublisher | undefined;
  let escalations: ConflictEscalationSweeper | undefined;
  let leaseSweeper: LeaseSweeper | undefined;
  let roomRetentionSweeper: RoomRetentionSweeper | undefined;
  let conflictReporter: ConflictMetricsReporter | undefined;
  let wakeWebhooks: WakeWebhookService | undefined;
  let executionService: ExecutionService | undefined;
  let pluginRunner: DockerToolRunner | undefined;
  let kmsOperations: AwsKmsDataKeyOperations | undefined;
  let gitApp: ReturnType<typeof buildInternalGitServer> | undefined;
  const oauthStateStore = config.oauth ? new RedisOAuthStateStore(redisClient) : undefined;
  const githubInstallStore = config.githubApp
    ? new RedisGitHubInstallStore(redisClient)
    : undefined;
  let healthInstallSweepTimer: NodeJS.Timeout | undefined;
  let sandboxLogSweepTimer: NodeJS.Timeout | undefined;
  if (overrides.publisher) {
    publisher = overrides.publisher;
  } else {
    redis = new RedisEventPublisher(redisClient);
    publisher = redis;
  }

  if (memoryIndexer) {
    const underlying = publisher;
    publisher = {
      publish: async (roomId, events) => {
        if (
          events.some(
            (event) =>
              event.type === "memory.updated" ||
              event.type === "memory.deleted" ||
              event.type === "event.redacted",
          )
        )
          memoryIndexer.schedule(roomId);
        await underlying.publish(roomId, events);
      },
    };
  }

  let redisSubscriber: RedisEventSubscriber | undefined;
  let subscriber: EventSubscriber;
  if (overrides.subscriber) {
    subscriber = overrides.subscriber;
  } else {
    redisSubscriber = new RedisEventSubscriber(redisSubscriberClient);
    subscriber = redisSubscriber;
  }

  const intentStore = new RedisEditIntentStore(redisClient);
  const intentSubscriber = new RedisEditIntentSubscriber(redisSubscriberClient);
  const presenceStore = new RedisPresenceStore(redisClient);
  const presenceSubscriber = new RedisPresenceSubscriber(redisSubscriberClient);
  const ownBudgets = overrides.budgets ? undefined : new RedisBudgetLimiter(redisClient);
  const budgets = overrides.budgets ?? ownBudgets!;
  const ownRoomExportLimiter = overrides.roomExportLimiter
    ? undefined
    : new RedisRoomExportLimiter(redisClient);
  const roomExportLimiter = overrides.roomExportLimiter ?? ownRoomExportLimiter!;
  const now = overrides.now ?? (() => new Date());
  const authRouteLimiter: RouteRateLimiter = {
    hit: async (key, limit, windowMs) => {
      const d = await budgets.consume(
        { room_id: "_auth", participant_id: key, budget: "commands" },
        limit,
        windowMs,
      );
      return d.allowed ? { allowed: true } : { allowed: false, retry_after_ms: d.retry_after_ms };
    },
  };
  const authRouteLimit = {
    limiter: authRouteLimiter,
    perMinute: config.refreshPerMinute ?? 30,
  };
  const sandboxLogStore = new FileLogStore(join(config.workspaceRoot, ".sandbox-exec-logs"));
  const sandboxOutputHub = new SandboxOutputHub();
  const sandboxOutput: SandboxOutputSource = {
    async get(execId) {
      const metadata = await sandboxLogStore.get(execId);
      return metadata ? toSandboxOutputMetadata(metadata) : undefined;
    },
    lastSequence: (execId) => sandboxLogStore.lastCursor(execId),
    read: (execId, afterCursor, limit) => sandboxLogStore.read(execId, afterCursor, limit),
    subscribe: (execId, listener) =>
      sandboxOutputHub.subscribe(execId, (update) =>
        listener(
          update.kind === "chunk"
            ? update
            : { kind: "finished", metadata: toSandboxOutputMetadata(update.metadata) },
        ),
      ),
  };

  try {
    if (redis) await redis.ready();
    await oauthStateStore?.ready();
    await githubInstallStore?.ready();
    await intentStore.ready();
    await presenceStore.ready();
    await ownBudgets?.ready();
    await sweepSandboxLogs(sandboxLogStore);
    sandboxLogSweepTimer = setInterval(
      () => void sweepSandboxLogs(sandboxLogStore),
      24 * 60 * 60 * 1000,
    );
    sandboxLogSweepTimer.unref();

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
        gitInternalNetwork: config.gitInternalNetwork ?? DEFAULT_GIT_INTERNAL_NETWORK,
        gitInternalPort: config.gitInternalPort ?? 8081,
        ...(config.gitInternalTokenSecret
          ? { gitInternalTokenSecret: config.gitInternalTokenSecret }
          : {}),
        gitFetcherImage: config.gitFetcherImage ?? "crossover-git-fetcher:latest",
      });
    const pathAuthorizer = overrides.authorize ?? authorize;
    const readableSandboxPaths = async (
      roomId: string,
      participantId: string,
      paths: readonly string[],
    ): Promise<string[]> =>
      withTransaction(pool, async (client) => {
        const { rows } = await client.query<Principal>(
          `SELECT id AS participant_id, room_id, kind, authority, role FROM participants
           WHERE id = $1 AND room_id = $2 AND status = 'ACTIVE'`,
          [participantId, roomId],
        );
        const principal = rows[0];
        if (!principal) return [];
        return filterReadablePaths(paths, async (path) => {
          try {
            await pathAuthorizer(
              principal,
              "workspace.read",
              { room_id: roomId, path },
              { method: "sandbox.status", params: {}, client },
            );
            return true;
          } catch (error) {
            if (error instanceof CrossoverError && error.code === "FORBIDDEN") return false;
            throw error;
          }
        });
      });
    executionService = new ExecutionService(pool, executionDriver, {
      diskEnforcement: config.sandboxDiskEnforcement ?? "soft",
      readablePaths: readableSandboxPaths,
      listIntents: (roomId) => intentStore.list(roomId),
      now,
    });
    executionService.startSweeper();

    const dispatcher = new Dispatcher({
      pool,
      authorize: pathAuthorizer,
      nodeId: config.nodeId,
      publisher,
      budgets,
      onLeaseAcquire: async (roomId) => {
        const { rows } = await pool.query<{ status: string; purge_started_at: Date | null }>(
          "SELECT status, purge_started_at FROM rooms WHERE id = $1",
          [roomId],
        );
        const room = rows[0];
        if (!(room?.status === "ARCHIVED" && room.purge_started_at)) {
          await reconcileRef(pool, roomId);
        }
      },
      ...(overrides.leaseTtlMs !== undefined ? { leaseTtlMs: overrides.leaseTtlMs } : {}),
    });
    executionService.setSandboxEventSink(async (roomId, events) => {
      await dispatcher.runSystem(roomId, "sandbox.canonical_advance", async () => ({
        result: undefined,
        events: [...events],
      }));
    });
    const healthRunner = new DockerHealthRunner({
      allowedImages: config.healthImages,
      checkoutRoot: join(config.workspaceRoot, ".health-checkouts"),
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
    const toolRegistry = overrides.tools?.registry ?? new ToolRegistry({ tierOf });
    if (!overrides.tools?.registry && config.githubPluginImage)
      registerGitHubTools(toolRegistry, config.githubPluginImage);
    if (!overrides.tools?.registry && config.browserPluginImage)
      registerBrowserTools(toolRegistry, config.browserPluginImage);
    if (!overrides.tools?.registry && config.awsPluginImage)
      registerAwsTools(toolRegistry, config.awsPluginImage);
    kmsOperations = config.integrationKmsKeyId ? new AwsKmsDataKeyOperations() : undefined;
    const integrationSecretStore =
      overrides.integrations?.secretStore ??
      (kmsOperations && config.integrationKmsKeyId
        ? new EnvelopeSecretStore(
            new KmsRoomDataKeyProvider(kmsOperations, config.integrationKmsKeyId),
          )
        : config.integrationSecretKey
          ? new EnvelopeSecretStore(new ConfigKeyRoomDataKeyProvider(config.integrationSecretKey))
          : undefined);
    const credentialBroker = integrationSecretStore
      ? new IntegrationCredentialBroker({
          pool,
          secretStore: integrationSecretStore,
          ...(config.githubApp ? { github: config.githubApp } : {}),
        })
      : undefined;
    const githubCredentials: GitCredentialProvider = {
      credentialFor: async (url, request) => {
        if (url.hostname.toLowerCase() !== "github.com" || !credentialBroker) return null;
        return credentialBroker.githubCredentialForRoom({
          ...request,
          repository: githubRepositoryFromUrl(url),
        });
      },
    };
    const upstream = {
      ...overrides.upstream,
      credentials: overrides.upstream?.credentials ?? githubCredentials,
      pullRequests: overrides.upstream?.pullRequests ?? new GitHubPullRequestProvider(),
    };
    const toolRunner =
      overrides.tools?.runner ??
      (pluginRunner = new DockerToolRunner({
        registry: toolRegistry,
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
        ...(credentialBroker
          ? {
              credentials: (invocation, execution) =>
                credentialBroker.credentialsFor(invocation, execution),
            }
          : {}),
        roomEgressHosts: async (invocation) => {
          const { rows } = await pool.query<{ hosts: unknown }>(
            "SELECT settings -> 'egress_allowlist' AS hosts FROM rooms WHERE id = $1",
            [invocation.room_id],
          );
          if (!rows[0]) throw new Error("Plugin room was not found");
          return normalizeRoomEgressAllowlist(rows[0].hosts);
        },
        timeoutMs: Math.min(overrides.tools?.timeoutMs ?? 60_000, 55_000),
      }));
    const integrationOptions: IntegrationCommandsOptions = {
      ...overrides.integrations,
      ...(integrationSecretStore ? { secretStore: integrationSecretStore } : {}),
      ...(overrides.integrations?.verifyAwsRole || !credentialBroker
        ? {}
        : { verifyAwsRole: credentialBroker.verifyAwsRole }),
      ...(overrides.integrations?.verifyGitHubInstallation || !credentialBroker || !config.githubApp
        ? {}
        : { verifyGitHubInstallation: credentialBroker.verifyGitHubInstallation }),
      ...(overrides.integrations?.githubPendingConnections || !githubInstallStore
        ? {}
        : { githubPendingConnections: githubInstallStore }),
    };
    registerCommands(
      dispatcher,
      config,
      healthQueue,
      intentStore,
      presenceStore,
      executionService,
      sandboxLogStore,
      sandboxOutputHub,
      {
        ...(overrides.tools ?? {}),
        registry: toolRegistry,
        runner: toolRunner,
      },
      budgets,
      upstream,
      integrationOptions,
      now,
      memoryProvider ? { provider: memoryProvider } : undefined,
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
    roomRetentionSweeper = new RoomRetentionSweeper({
      pool,
      dispatcher,
      now,
      purgeWorkspace: (roomId, repoPath) =>
        purgeRoomWorkspace({
          workspaceRoot: config.workspaceRoot,
          roomId,
          repoPath,
          destroyRoom: (id) => executionService!.destroyRoom(id),
        }),
    });
    roomRetentionSweeper.start();
    // A daily conflict-rate report on stdout (T1586); an interval of 0 turns it off.
    if ((config.conflictReportIntervalMs ?? 86_400_000) > 0) {
      conflictReporter = new ConflictMetricsReporter({
        pool,
        intervalMs: config.conflictReportIntervalMs ?? 86_400_000,
        now,
      });
      conflictReporter.start();
    }
    // Runs without a key too: then it sends nothing and only keeps the outbox from growing.
    wakeWebhooks = new WakeWebhookService({
      pool,
      key: config.wakeWebhookKey,
      sender: (request) => postWebhook(request),
    });
    wakeWebhooks.start();

    // One line per unexpected failure, as JSON on stderr: the same shape for REST and MCP (T1575).
    const logInternalError = (error: unknown, fields: Record<string, unknown>) => {
      const stack =
        error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
      // JSON keeps stack newlines escaped so each failure is a single stderr line.
      console.error(JSON.stringify({ event: "gateway.internal_error", ...fields, stack }));
    };

    const app = buildGateway({
      dispatcher,
      pool,
      onInternalError: (error, request) => {
        const body =
          typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)
            ? (request.body as Record<string, unknown>)
            : undefined;
        const params =
          typeof body?.params === "object" && body.params !== null && !Array.isArray(body.params)
            ? (body.params as Record<string, unknown>)
            : undefined;
        const route = request.routeOptions.url;
        const commandRoute = route === "/v1/commands" || route === "/v1/rooms/:roomId/commands";
        const candidate = commandRoute
          ? typeof body?.method === "string"
            ? body.method
            : undefined
          : route === "/mcp" && body?.method === "tools/call" && typeof params?.name === "string"
            ? MCP_TOOLS.find((tool) => tool.name === params.name)?.method
            : undefined;
        const commandMethod =
          candidate && /^[a-zA-Z][a-zA-Z0-9_./-]{0,127}$/.test(candidate) ? candidate : undefined;

        // Only the route pattern and command method are included; never log request URLs, headers, or other body fields.
        logInternalError(error, {
          method: request.method,
          route: request.routeOptions.url ?? "<unmatched>",
          ...(commandMethod ? { command_method: commandMethod } : {}),
        });
      },
      devLogin: config.devLogin,
      secureCookies: config.secureCookies,
      oauth:
        config.oauth && oauthStateStore
          ? {
              publicBaseUrl: config.oauth.publicBaseUrl,
              stateStore: oauthStateStore,
              providers: overrides.oauthProviders ?? {
                ...(config.oauth.github
                  ? { github: githubOAuthProvider(config.oauth.github) }
                  : {}),
                ...(config.oauth.google
                  ? { google: googleOAuthProvider(config.oauth.google) }
                  : {}),
              },
            }
          : undefined,
      ...(config.githubApp && credentialBroker && githubInstallStore
        ? {
            githubAppInstall: {
              slug: config.githubApp.slug,
              stateStore: githubInstallStore,
              pendingConnections: githubInstallStore,
              authorizeInstallation: credentialBroker.authorizeGitHubInstallation,
            },
          }
        : {}),
      trustProxy: config.trustProxy && config.trustProxy.length > 0 ? config.trustProxy : false,
      refreshLimit: authRouteLimit,
      oauthStartLimit: authRouteLimit,
      ...(config.webRoot ? { staticRoot: config.webRoot } : {}),
      ws: {
        subscriber,
        sandboxOutput,
        presence: presenceSubscriber,
        intents: intentSubscriber,
        intentStore,
      },
      roomExport: { source: new RoomExportService(pool), limiter: roomExportLimiter },
    });
    gitApp = buildInternalGitServer({
      pool,
      authorize: overrides.authorize ?? authorize,
      ...(config.gitInternalTokenSecret ? { tokenSecret: config.gitInternalTokenSecret } : {}),
    });
    // POST /mcp, the agents' tool surface; an INTERNAL tool error is logged like the REST one, minus arguments
    registerMcp(app, {
      dispatcher,
      pool,
      onInternalError: (error, context) =>
        logInternalError(error, {
          method: "POST",
          route: "/mcp",
          command_method: context.method,
          tool: context.tool,
          room_id: context.room_id,
          participant_id: context.participant_id,
          command_id: context.command_id,
        }),
    });

    // The room A2A endpoint (T1623), only when enabled; off, /a2a/* is a plain 404.
    if (config.a2aInbound) {
      registerA2aInbound(app, {
        dispatcher,
        pool,
        publicBaseUrl: config.a2aInbound.publicBaseUrl,
        onInternalError: (error, context) =>
          logInternalError(error, {
            method: "POST",
            route: "/a2a/rooms/:roomId",
            command_method: context.method,
            room_id: context.room_id,
            participant_id: context.participant_id,
          }),
      });
    }

    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        await escalations?.stop();
        await leaseSweeper?.stop();
        await roomRetentionSweeper?.stop();
        await conflictReporter?.stop();
        if (healthInstallSweepTimer) clearInterval(healthInstallSweepTimer);
        if (sandboxLogSweepTimer) clearInterval(sandboxLogSweepTimer);
        await wakeWebhooks?.stop();
        await memoryIndexer?.close();
        await executionService?.close();
        await pluginRunner?.close();
        kmsOperations?.close();
        await renewer.stop();
        await gitApp?.close();
        await app.close();
        await healthQueue.close();
        await renewer.close(); // releases every lease once nothing can take a new one
        await redis?.close();
        await redisSubscriber?.close();
        await intentStore.close();
        await intentSubscriber.close();
        await presenceStore.close();
        await presenceSubscriber.close();
        await ownBudgets?.close();
        await ownRoomExportLimiter?.close();
        await oauthStateStore?.close();
        await githubInstallStore?.close();
        await redisClient.quit().catch(() => redisClient.disconnect());
        redisSubscriberClient.disconnect();
        if (!overrides.pool) await pool.end();
      })());

    memoryIndexer?.start();
    if (memoryProvider)
      console.warn("memory search: local-hash provider (lexical; development and tests)");
    return { app, gitApp, dispatcher, pool, execution: executionService, renewer, close };
  } catch (err) {
    await escalations?.stop();
    await leaseSweeper?.stop();
    await roomRetentionSweeper?.stop();
    await conflictReporter?.stop();
    if (healthInstallSweepTimer) clearInterval(healthInstallSweepTimer);
    if (sandboxLogSweepTimer) clearInterval(sandboxLogSweepTimer);
    await wakeWebhooks?.stop();
    await memoryIndexer?.close();
    await executionService?.close();
    await pluginRunner?.close();
    kmsOperations?.close();
    await gitApp?.close();
    await redis?.close();
    await redisSubscriber?.close();
    await intentStore.close();
    await intentSubscriber.close();
    await presenceStore.close();
    await presenceSubscriber.close();
    await ownBudgets?.close();
    await ownRoomExportLimiter?.close();
    await oauthStateStore?.close();
    await githubInstallStore?.close();
    await redisClient.quit().catch(() => redisClient.disconnect());
    redisSubscriberClient.disconnect();
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
  presenceStore: RedisPresenceStore,
  execution: ExecutionService,
  logs: LogStore,
  outputHub: SandboxOutputHub,
  tools: { registry: ToolRegistry; runner: ToolRunner; timeoutMs?: number },
  budgets: BudgetLimiter,
  upstream?: UpstreamDeps,
  integrationOptions: IntegrationCommandsOptions = {},
  now: () => Date = () => new Date(),
  memorySearch?: { provider: EmbeddingProvider },
): void {
  void memorySearch;
  registerRoomCommands(dispatcher, {
    provision: async ({ client, room_id }) => {
      await provisionWorkspace(client, room_id, config.workspaceRoot);
    },
  });
  registerBudgetCommands(dispatcher, budgets, now);
  registerRoomProtectedPathsCommand(dispatcher);
  registerRoomHealthSettingsCommand(dispatcher, {
    allowedImages: config.healthImages,
    defaultImage: DEFAULT_HEALTH_IMAGE,
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
  registerRoomRetentionCommands(dispatcher);
  registerRoomEventsCommand(dispatcher);
  registerEventsRedactCommand(dispatcher);
  registerRoomDigestCommand(dispatcher);
  registerInboxCommands(dispatcher);
  registerApprovalCommands(dispatcher);
  registerToolCommands(dispatcher, {
    registry: tools.registry,
    runner: tools.runner,
    ...(tools.timeoutMs !== undefined ? { timeoutMs: tools.timeoutMs } : {}),
  });
  registerIntegrationCommands(dispatcher, integrationOptions);
  registerWakeSecretCommand(dispatcher, config.wakeWebhookKey);
  registerPresenceIntentCommands(dispatcher, intentStore, normalizePath);
  registerPresenceCommands(dispatcher, presenceStore, normalizePath);
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
  const workspaceDeps: WorkspaceCommandDeps = {
    scheduleHealthCheck: (roomId, revision) => healthQueue.enqueue(roomId, revision),
    scheduleSandboxAdvance: (roomId, revision) =>
      execution.scheduleCanonicalAdvance(roomId, revision),
    ...(upstream ? { upstream } : {}),
  };
  registerWorkspaceCommands(dispatcher, workspaceDeps);
  registerSandboxStatusCommand(dispatcher, execution);
  registerSandboxFileCommands(dispatcher, execution);
  registerSandboxSyncCommand(dispatcher, execution);
  registerSandboxSubmitCommand(dispatcher, execution, workspaceDeps);
  registerSandboxExecCommands(dispatcher, execution, logs, { outputHub });
}

async function sweepSandboxLogs(logs: LogStore): Promise<void> {
  try {
    await logs.sweepExpired();
  } catch (error) {
    process.emitWarning(
      error instanceof Error ? error : new Error(String(error)),
      "SandboxLogSweepWarning",
    );
  }
}

function toSandboxOutputMetadata(metadata: SandboxExecLogMetadata): SandboxOutputMetadata {
  return {
    exec_id: metadata.exec_id,
    room_id: metadata.room_id,
    sandbox_id: metadata.sandbox_id,
    participant_id: metadata.participant_id,
    ...(metadata.finished_at !== undefined ? { finished_at: metadata.finished_at } : {}),
    ...(metadata.exit_code !== undefined ? { exit_code: metadata.exit_code } : {}),
    ...(metadata.duration_ms !== undefined ? { duration_ms: metadata.duration_ms } : {}),
    ...(metadata.reason !== undefined ? { reason: metadata.reason } : {}),
    truncated: metadata.truncated,
  };
}
