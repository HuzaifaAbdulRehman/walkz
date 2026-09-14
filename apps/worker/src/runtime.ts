import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import type { ConnectionOptions, Worker } from 'bullmq';
import type { DockerWorkspaceVolume } from '@walkz/sandbox';
import {
  prepareVerifiedPatchProposal,
  WALKZ_REVIEW_PROMPT_VERSION,
} from '@walkz/engine';
import {
  createInstallationGitHubCommentCommandClientFactory,
  createGitHubInstallationApp,
  createInstallationPullRequestReaderFactory,
  createInstallationReviewCheckPublisherFactory,
  createInstallationGitHubSuggestionServiceFactory,
} from '@walkz/github';
import {
  claimGitHubCommentCommand,
  claimPatchFixJob,
  claimHostedReviewRun,
  completeGitHubCommentCommand,
  completePatchFixJob,
  completeHostedReviewRun,
  createCredentialVault,
  createDatabasePool,
  createOutboxEventStore,
  createPatchFixProposalForCommentCommand,
  failGitHubCommentCommand,
  failPatchFixJob,
  getLatestPatchReproofResult,
  listRecoverablePatchFixProposalIds,
  listRecoverableGitHubCommentCommandIds,
  listRecoverableHostedReviewRunIds,
  loadDurableOperationalTelemetry,
  loadLatestVerifiedPatchFixSourceForPullRequest,
  loadClaimedPatchFixTarget,
  loadProviderCredential,
  queueManualReview,
  recordModelInvocation,
  recordPatchReproofResult,
  releaseGitHubCommentCommand,
  releasePatchFixJob,
  renewGitHubCommentCommandLease,
  renewPatchFixJobLease,
  renewHostedReviewRunLease,
} from '@walkz/persistence';
import {
  createGroqProvider,
  withModelInvocationTelemetry,
} from '@walkz/providers';
import { z } from 'zod';

import {
  createCommentCommandQueue,
  createCommentCommandWorker,
  createGitHubCommentCommandJobHandler,
  createGitHubCheckOutboxHandler,
  createHostedOutboxHandler,
  createHostedReviewJobHandler,
  createOutboxQueue,
  createOutboxWorker,
  createPatchFixQueue,
  createPatchFixWorker,
  createHostedPatchFixJobHandler,
  createReviewQueue,
  createReviewWorker,
  recoverOutboxEvents,
  recoverCommentCommands,
  recoverReviewRuns,
  recoverPatchFixes,
  type HostedReviewStore,
} from './index.js';
import {
  createStructuredOperationalLogger,
  createWorkerOperationalTelemetry,
  type StructuredOperationalLogger,
  type WorkerOperationalTelemetry,
  type WorkerQueueName,
} from './operational-telemetry.js';
import {
  createWorkerOperationsServer,
  type DependencyStatus,
  type WorkerQueueCounts,
} from './operations-server.js';

const base64Schema = z.string().min(1).max(100_000).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const environmentSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  GITHUB_APP_ID: z.string().regex(/^[1-9][0-9]{0,15}$/).refine(
    (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
    'GitHub App ID must be a safe JavaScript integer.',
  ),
  GITHUB_PRIVATE_KEY_BASE64: base64Schema,
  WALKZ_CREDENTIAL_ACTIVE_KEY_ID: z.string().trim().min(1).max(128),
  WALKZ_CREDENTIAL_KEYS_JSON: z.string().min(1).max(100_000),
  WALKZ_WORKER_ID: z.string().trim().min(1).max(128).optional(),
  WALKZ_OUTBOX_LEASE_MS: z.coerce.number().int().min(1_000).max(300_000)
    .default(30_000),
  WALKZ_REVIEW_LEASE_MS: z.coerce.number().int().min(10_000)
    .max(60 * 60 * 1_000).default(300_000),
  WALKZ_COMMENT_COMMAND_LEASE_MS: z.coerce.number().int().min(10_000)
    .max(60 * 60 * 1_000).default(60_000),
  WALKZ_PUBLIC_URL: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.username.length === 0 && url.password.length === 0 &&
      (url.pathname === '' || url.pathname === '/') &&
      url.search.length === 0 && url.hash.length === 0;
  }, 'WALKZ_PUBLIC_URL must be an HTTPS origin without credentials.'),
  WALKZ_PATCH_FIX_LEASE_MS: z.coerce.number().int().min(10_000)
    .max(60 * 60 * 1_000).default(600_000),
  WALKZ_PROOF_IMAGE: z.string().trim().max(512)
    .regex(/^(?!-)[^\s@]+@sha256:[a-f0-9]{64}$/i)
    .default('node@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf'),
  WALKZ_PROOF_WORKSPACE_ROOT: z.string().trim().min(1).max(4_096)
    .refine((value) => isAbsolute(value), 'Proof workspace root must be absolute.')
    .optional(),
  WALKZ_DOCKER_WORKSPACE_VOLUME: z.string().trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
    .optional(),
  WALKZ_RECOVERY_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000)
    .default(15_000),
  WALKZ_RECOVERY_BATCH: z.coerce.number().int().min(1).max(1_000).default(100),
  WALKZ_TELEMETRY_HOST: z.string().trim().min(1).max(255).default('127.0.0.1'),
  WALKZ_TELEMETRY_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
}).passthrough().superRefine((environment, context) => {
  if (
    (environment.WALKZ_PROOF_WORKSPACE_ROOT === undefined) !==
    (environment.WALKZ_DOCKER_WORKSPACE_VOLUME === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Proof workspace root and Docker volume must be configured together.',
      path: ['WALKZ_DOCKER_WORKSPACE_VOLUME'],
    });
  }
});

export interface HostedWorkerEnvironment {
  databaseUrl: string;
  redis: ConnectionOptions;
  githubAppId: string;
  githubPrivateKey: string;
  credentialVault: ReturnType<typeof createCredentialVault>;
  workerId: string;
  outboxLeaseMs: number;
  reviewLeaseMs: number;
  commentCommandLeaseMs: number;
  publicUrl: string;
  patchFixLeaseMs: number;
  proofImage: string;
  workspaceVolume?: DockerWorkspaceVolume;
  recoveryIntervalMs: number;
  recoveryBatch: number;
  telemetryHost: string;
  telemetryPort: number;
}

export interface HostedWorkerRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
}

function decodePrivateKey(encoded: string): string {
  const decoded = Buffer.from(encoded, 'base64').toString('utf8').trim();
  if (
    !decoded.startsWith('-----BEGIN') ||
    !decoded.endsWith('PRIVATE KEY-----') ||
    Buffer.byteLength(decoded, 'utf8') > 65_536
  ) {
    throw new Error('GITHUB_PRIVATE_KEY_BASE64 must contain a PEM private key.');
  }
  return decoded;
}

function decodeRedisPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error('REDIS_URL contains invalid percent encoding.');
  }
}

function parseRedisConnection(value: string): ConnectionOptions {
  const url = new URL(value);
  if (
    (url.protocol !== 'redis:' && url.protocol !== 'rediss:') ||
    url.hostname.length === 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('REDIS_URL must be a redis or rediss URL without query or fragment data.');
  }
  const databaseText = url.pathname.replace(/^\//, '');
  if (databaseText.length > 0 && !/^\d+$/.test(databaseText)) {
    throw new Error('REDIS_URL database must be a nonnegative integer.');
  }
  const database = databaseText.length === 0 ? 0 : Number(databaseText);
  if (!Number.isSafeInteger(database) || database > 15) {
    throw new Error('REDIS_URL database must be between 0 and 15.');
  }
  return {
    host: url.hostname,
    port: Number(url.port || '6379'),
    db: database,
    maxRetriesPerRequest: null,
    ...(url.username.length > 0 ? { username: decodeRedisPart(url.username) } : {}),
    ...(url.password.length > 0 ? { password: decodeRedisPart(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: { servername: url.hostname } } : {}),
  };
}

function parseCredentialKeys(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('WALKZ_CREDENTIAL_KEYS_JSON must contain a JSON object.');
  }
}

export function parseHostedWorkerEnvironment(
  input: NodeJS.ProcessEnv,
): HostedWorkerEnvironment {
  const environment = environmentSchema.parse(input);
  return {
    databaseUrl: environment.DATABASE_URL,
    redis: parseRedisConnection(environment.REDIS_URL),
    githubAppId: environment.GITHUB_APP_ID,
    githubPrivateKey: decodePrivateKey(environment.GITHUB_PRIVATE_KEY_BASE64),
    credentialVault: createCredentialVault({
      activeKeyId: environment.WALKZ_CREDENTIAL_ACTIVE_KEY_ID,
      keys: parseCredentialKeys(environment.WALKZ_CREDENTIAL_KEYS_JSON),
    }),
    workerId: environment.WALKZ_WORKER_ID ??
      `${hostname()}-${process.pid}-${randomUUID()}`.slice(0, 128),
    outboxLeaseMs: environment.WALKZ_OUTBOX_LEASE_MS,
    reviewLeaseMs: environment.WALKZ_REVIEW_LEASE_MS,
    commentCommandLeaseMs: environment.WALKZ_COMMENT_COMMAND_LEASE_MS,
    publicUrl: environment.WALKZ_PUBLIC_URL,
    patchFixLeaseMs: environment.WALKZ_PATCH_FIX_LEASE_MS,
    proofImage: environment.WALKZ_PROOF_IMAGE,
    ...(environment.WALKZ_PROOF_WORKSPACE_ROOT === undefined ||
      environment.WALKZ_DOCKER_WORKSPACE_VOLUME === undefined
      ? {}
      : {
          workspaceVolume: {
            name: environment.WALKZ_DOCKER_WORKSPACE_VOLUME,
            root: environment.WALKZ_PROOF_WORKSPACE_ROOT,
          },
        }),
    recoveryIntervalMs: environment.WALKZ_RECOVERY_INTERVAL_MS,
    recoveryBatch: environment.WALKZ_RECOVERY_BATCH,
    telemetryHost: environment.WALKZ_TELEMETRY_HOST,
    telemetryPort: environment.WALKZ_TELEMETRY_PORT,
  };
}

function observeWorker(
  worker: Worker,
  queue: WorkerQueueName,
  telemetry: WorkerOperationalTelemetry,
  logger: StructuredOperationalLogger,
  reportBackgroundError: () => void,
): void {
  worker.on('active', (job) => telemetry.recordStarted(queue, job.timestamp));
  worker.on('completed', (job) => {
    telemetry.recordCompleted(queue, job.processedOn);
  });
  worker.on('failed', (job) => {
    telemetry.recordFailed(queue);
    logger.write({
      event: 'job_failed',
      queue,
      attempt: job?.attemptsMade ?? 0,
    });
  });
  worker.on('error', () => {
    telemetry.recordWorkerError(queue);
    logger.write({ event: 'worker_error', queue });
    reportBackgroundError();
  });
}

async function dependencyStatus(operation: () => Promise<unknown>): Promise<DependencyStatus> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const finish = (status: 'up' | 'down'): void => {
      clearTimeout(timer);
      resolve({ status, latencyMs: Math.max(0, Date.now() - startedAt) });
    };
    const timer = setTimeout(() => finish('down'), 1_000);
    timer.unref();
    void operation().then(
      () => finish('up'),
      () => finish('down'),
    );
  });
}

function coalesceOperation<T>(operation: () => Promise<T>): () => Promise<T> {
  let active: Promise<T> | undefined;
  return () => {
    active ??= operation().finally(() => {
      active = undefined;
    });
    return active;
  };
}

async function queueCounts(queue: {
  getJobCounts(...types: Array<'wait' | 'active' | 'delayed' | 'failed'>):
    Promise<Record<string, number>>;
}): Promise<WorkerQueueCounts> {
  const counts = await queue.getJobCounts('wait', 'active', 'delayed', 'failed');
  return {
    wait: counts.wait ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    failed: counts.failed ?? 0,
  };
}

export function createHostedWorkerFromEnvironment(
  input: NodeJS.ProcessEnv,
  onBackgroundError: () => void = () => undefined,
): HostedWorkerRuntime {
  const config = parseHostedWorkerEnvironment(input);
  const telemetry = createWorkerOperationalTelemetry();
  const logger = createStructuredOperationalLogger();
  const pool = createDatabasePool({
    connectionString: config.databaseUrl,
    maxConnections: 10,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 30_000,
  });
  const githubApp = createGitHubInstallationApp({
    appId: config.githubAppId,
    privateKey: config.githubPrivateKey,
    requestTimeoutMs: 15_000,
  });
  const githubSuggestions = createInstallationGitHubSuggestionServiceFactory(githubApp);
  const outboxStore = createOutboxEventStore(pool);
  const reviewStore: HostedReviewStore = {
    claim: (lease) => claimHostedReviewRun(pool, lease),
    renew: (lease) => renewHostedReviewRunLease(pool, lease),
    loadCredential: (binding) =>
      loadProviderCredential(pool, config.credentialVault, binding),
    recordModelInvocation: async ({ reviewRunId, event }) => {
      await recordModelInvocation(pool, { reviewRunId, ...event });
    },
    complete: (result) => completeHostedReviewRun(pool, result),
  };
  const outboxQueue = createOutboxQueue(config.redis);
  const commentCommandQueue = createCommentCommandQueue(config.redis);
  const patchFixQueue = createPatchFixQueue(config.redis);
  const reviewQueue = createReviewQueue(config.redis);
  const reviewHandler = createHostedReviewJobHandler({
    store: reviewStore,
    tokens: githubApp,
    workerId: config.workerId,
    leaseMs: config.reviewLeaseMs,
    proofImage: config.proofImage,
    ...(config.workspaceVolume === undefined
      ? {}
      : { workspaceVolume: config.workspaceVolume }),
  });
  const patchFixHandler = createHostedPatchFixJobHandler({
    store: {
      claim: (lease) => claimPatchFixJob(pool, lease),
      renew: (lease) => renewPatchFixJobLease(pool, lease),
      loadTarget: (target) => loadClaimedPatchFixTarget(pool, target),
      latestReproof: (proposalId) => getLatestPatchReproofResult(pool, proposalId),
      recordReproof: (result) => recordPatchReproofResult(pool, result),
      complete: (completion) => completePatchFixJob(pool, completion),
      release: (lease) => releasePatchFixJob(pool, lease),
      fail: (failure) => failPatchFixJob(pool, failure),
    },
    tokens: githubApp,
    github: githubSuggestions,
    workerId: config.workerId,
    leaseMs: config.patchFixLeaseMs,
    proofImage: config.proofImage,
    ...(config.workspaceVolume === undefined
      ? {}
      : { workspaceVolume: config.workspaceVolume }),
  });
  const commentCommandHandler = createGitHubCommentCommandJobHandler({
    store: {
      claim: (lease) => claimGitHubCommentCommand(pool, lease),
      renew: (lease) => renewGitHubCommentCommandLease(pool, lease),
      queueReview: (review) => queueManualReview(pool, review),
      complete: (completion) => completeGitHubCommentCommand(pool, completion),
      release: (lease) => releaseGitHubCommentCommand(pool, lease),
      fail: (failure) => failGitHubCommentCommand(pool, failure),
    },
    comments: createInstallationGitHubCommentCommandClientFactory(
      githubApp,
      Number(config.githubAppId),
    ),
    pullRequests: createInstallationPullRequestReaderFactory(githubApp),
    proposals: {
      async prepare(command, signal) {
        const source = await loadLatestVerifiedPatchFixSourceForPullRequest(pool, {
          repositoryId: command.repositoryId,
          pullRequestNumber: command.pullRequestNumber,
        });
        if (source === null) return null;
        const prepared = await prepareVerifiedPatchProposal(
          source,
          config.proofImage,
          {
            loadCredential: (binding) =>
              loadProviderCredential(pool, config.credentialVault, binding),
            async loadHeadFile(target) {
              const service = await githubSuggestions.forInstallation(
                target.installationId,
              );
              return service.loadHeadFile({
                owner: target.owner,
                repository: target.repository,
                pullRequestNumber: target.pullRequestNumber,
                headSha: target.headSha,
                path: target.path,
              });
            },
            createProvider: (apiKey) => withModelInvocationTelemetry(
              createGroqProvider({ apiKey }),
              {
                operationId: `${source.reviewRunId}:${source.findingId}:${source.headSha}`,
                record: async (event) => {
                  await recordModelInvocation(pool, {
                    reviewRunId: source.reviewRunId,
                    ...event,
                  });
                },
              },
            ),
            createProposal: (proposal) =>
              createPatchFixProposalForCommentCommand(pool, {
                ...proposal,
                commandId: command.commandId,
                workerId: config.workerId,
              }),
          },
          signal,
        );
        return {
          proposalId: prepared.proposal.id,
          reviewRunId: prepared.proposal.reviewRunId,
          headSha: prepared.proposal.headSha,
        };
      },
    },
    workerId: config.workerId,
    leaseMs: config.commentCommandLeaseMs,
    promptVersion: WALKZ_REVIEW_PROMPT_VERSION,
    dashboardUrl: config.publicUrl,
  });
  const outboxHandler = createHostedOutboxHandler({
    checks: createGitHubCheckOutboxHandler(
      createInstallationReviewCheckPublisherFactory(githubApp),
    ),
    commentCommands: commentCommandQueue,
    patchFixes: patchFixQueue,
    reviews: reviewQueue,
  });
  const outboxWorker = createOutboxWorker(
    config.redis,
    outboxStore,
    outboxHandler,
    { workerId: config.workerId, leaseMs: config.outboxLeaseMs },
  );
  const reviewWorker = createReviewWorker(config.redis, reviewHandler);
  const commentCommandWorker = createCommentCommandWorker(
    config.redis,
    commentCommandHandler,
  );
  const patchFixWorker = createPatchFixWorker(config.redis, patchFixHandler);
  const dependencyStates: Partial<Record<'postgres' | 'redis', 'up' | 'down'>> = {};
  const recordDependencyState = (
    dependency: 'postgres' | 'redis',
    status: 'up' | 'down',
  ): void => {
    const previous = dependencyStates[dependency];
    dependencyStates[dependency] = status;
    if (status === 'down' && previous !== 'down') {
      logger.write({ event: 'dependency_check_failed', dependency });
    } else if (status === 'up' && previous === 'down') {
      logger.write({ event: 'dependency_recovered', dependency });
    }
  };
  const reportBackgroundError = (): void => {
    try {
      onBackgroundError();
    } catch {}
  };
  observeWorker(outboxWorker, 'outbox', telemetry, logger, reportBackgroundError);
  observeWorker(
    commentCommandWorker,
    'comment_commands',
    telemetry,
    logger,
    reportBackgroundError,
  );
  observeWorker(reviewWorker, 'reviews', telemetry, logger, reportBackgroundError);
  observeWorker(patchFixWorker, 'patch_fixes', telemetry, logger, reportBackgroundError);
  const checkPostgres = coalesceOperation(() => pool.query('SELECT 1 AS ready'));
  const checkRedis = coalesceOperation(() => reviewQueue.getJobCounts('wait'));

  const operationsServer = createWorkerOperationsServer({
    host: config.telemetryHost,
    port: config.telemetryPort,
    telemetry,
    dependencies: {
      async check() {
        const [postgres, redis] = await Promise.all([
          dependencyStatus(checkPostgres),
          dependencyStatus(checkRedis),
        ]);
        recordDependencyState('postgres', postgres.status);
        recordDependencyState('redis', redis.status);
        return { postgres, redis };
      },
    },
    metrics: {
      async load() {
        const [outbox, commentCommands, reviews, patchFixes, durable] =
          await Promise.all([
            queueCounts(outboxQueue),
            queueCounts(commentCommandQueue),
            queueCounts(reviewQueue),
            queueCounts(patchFixQueue),
            loadDurableOperationalTelemetry(pool),
          ]);
        return {
          queues: {
            outbox,
            comment_commands: commentCommands,
            reviews,
            patch_fixes: patchFixes,
          },
          durable,
        };
      },
    },
  });

  let started = false;
  let stopping = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recovery = Promise.resolve();

  const recover = async (): Promise<void> => {
    try {
      await recoverOutboxEvents(outboxQueue, outboxStore, config.recoveryBatch);
      await recoverCommentCommands(commentCommandQueue, {
        listRecoverableGitHubCommentCommandIds: (limit) =>
          listRecoverableGitHubCommentCommandIds(pool, limit),
      }, config.recoveryBatch);
      await recoverReviewRuns(reviewQueue, {
        listRecoverableReviewRunIds: (limit) =>
          listRecoverableHostedReviewRunIds(pool, limit),
      }, config.recoveryBatch);
      await recoverPatchFixes(patchFixQueue, {
        listRecoverablePatchFixProposalIds: (limit) =>
          listRecoverablePatchFixProposalIds(pool, limit),
      }, config.recoveryBatch);
      telemetry.recordRecovery('completed');
    } catch (error) {
      telemetry.recordRecovery('failed');
      logger.write({ event: 'recovery_failed' });
      throw error;
    }
  };
  const scheduleRecovery = (): void => {
    const jitterMs = Math.floor(Math.random() * Math.min(5_000, config.recoveryIntervalMs));
    recoveryTimer = setTimeout(() => {
      recovery = recover()
        .catch(() => reportBackgroundError())
        .finally(() => {
          if (!stopping) scheduleRecovery();
        });
    }, config.recoveryIntervalMs + jitterMs);
    recoveryTimer.unref();
  };

  return {
    async start() {
      if (started) return;
      started = true;
      await Promise.all([
        outboxQueue.waitUntilReady(),
        commentCommandQueue.waitUntilReady(),
        patchFixQueue.waitUntilReady(),
        reviewQueue.waitUntilReady(),
        outboxWorker.waitUntilReady(),
        commentCommandWorker.waitUntilReady(),
        reviewWorker.waitUntilReady(),
        patchFixWorker.waitUntilReady(),
      ]);
      await recover();
      await operationsServer.start();
      scheduleRecovery();
      logger.write({ event: 'service_started' });
    },
    async close() {
      if (stopping) return;
      stopping = true;
      if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
      await operationsServer.close();
      await recovery;
      const results = await Promise.allSettled([
        outboxWorker.close(),
        commentCommandWorker.close(),
        reviewWorker.close(),
        patchFixWorker.close(),
      ]);
      const queueResults = await Promise.allSettled([
        outboxQueue.close(),
        commentCommandQueue.close(),
        patchFixQueue.close(),
        reviewQueue.close(),
        pool.end(),
      ]);
      const failures = [...results, ...queueResults]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Hosted worker shutdown failed.');
      }
      logger.write({ event: 'service_stopped' });
    },
  };
}
