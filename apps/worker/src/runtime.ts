import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import type { ConnectionOptions } from 'bullmq';
import {
  createGitHubInstallationApp,
  createInstallationReviewCheckPublisherFactory,
} from '@walkz/github';
import {
  claimHostedReviewRun,
  completeHostedReviewRun,
  createCredentialVault,
  createDatabasePool,
  createOutboxEventStore,
  listRecoverableHostedReviewRunIds,
  loadProviderCredential,
  renewHostedReviewRunLease,
} from '@walkz/persistence';
import { z } from 'zod';

import {
  createGitHubCheckOutboxHandler,
  createHostedOutboxHandler,
  createHostedReviewJobHandler,
  createOutboxQueue,
  createOutboxWorker,
  createReviewQueue,
  createReviewWorker,
  recoverOutboxEvents,
  recoverReviewRuns,
  type HostedReviewStore,
} from './index.js';

const base64Schema = z.string().min(1).max(100_000).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const environmentSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  GITHUB_APP_ID: z.string().trim().min(1).max(128),
  GITHUB_PRIVATE_KEY_BASE64: base64Schema,
  WALKZ_CREDENTIAL_ACTIVE_KEY_ID: z.string().trim().min(1).max(128),
  WALKZ_CREDENTIAL_KEYS_JSON: z.string().min(1).max(100_000),
  WALKZ_WORKER_ID: z.string().trim().min(1).max(128).optional(),
  WALKZ_OUTBOX_LEASE_MS: z.coerce.number().int().min(1_000).max(300_000)
    .default(30_000),
  WALKZ_REVIEW_LEASE_MS: z.coerce.number().int().min(10_000)
    .max(60 * 60 * 1_000).default(300_000),
  WALKZ_RECOVERY_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000)
    .default(15_000),
  WALKZ_RECOVERY_BATCH: z.coerce.number().int().min(1).max(1_000).default(100),
}).passthrough();

export interface HostedWorkerEnvironment {
  databaseUrl: string;
  redis: ConnectionOptions;
  githubAppId: string;
  githubPrivateKey: string;
  credentialVault: ReturnType<typeof createCredentialVault>;
  workerId: string;
  outboxLeaseMs: number;
  reviewLeaseMs: number;
  recoveryIntervalMs: number;
  recoveryBatch: number;
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
    recoveryIntervalMs: environment.WALKZ_RECOVERY_INTERVAL_MS,
    recoveryBatch: environment.WALKZ_RECOVERY_BATCH,
  };
}

export function createHostedWorkerFromEnvironment(
  input: NodeJS.ProcessEnv,
  onBackgroundError: () => void = () => undefined,
): HostedWorkerRuntime {
  const config = parseHostedWorkerEnvironment(input);
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
  const outboxStore = createOutboxEventStore(pool);
  const reviewStore: HostedReviewStore = {
    claim: (lease) => claimHostedReviewRun(pool, lease),
    renew: (lease) => renewHostedReviewRunLease(pool, lease),
    loadCredential: (binding) =>
      loadProviderCredential(pool, config.credentialVault, binding),
    complete: (result) => completeHostedReviewRun(pool, result),
  };
  const outboxQueue = createOutboxQueue(config.redis);
  const reviewQueue = createReviewQueue(config.redis);
  const reviewHandler = createHostedReviewJobHandler({
    store: reviewStore,
    tokens: githubApp,
    workerId: config.workerId,
    leaseMs: config.reviewLeaseMs,
  });
  const outboxHandler = createHostedOutboxHandler({
    checks: createGitHubCheckOutboxHandler(
      createInstallationReviewCheckPublisherFactory(githubApp),
    ),
    reviews: reviewQueue,
  });
  const outboxWorker = createOutboxWorker(
    config.redis,
    outboxStore,
    outboxHandler,
    { workerId: config.workerId, leaseMs: config.outboxLeaseMs },
  );
  const reviewWorker = createReviewWorker(config.redis, reviewHandler);
  const reportBackgroundError = (): void => {
    try {
      onBackgroundError();
    } catch {}
  };
  outboxWorker.on('error', reportBackgroundError);
  reviewWorker.on('error', reportBackgroundError);

  let started = false;
  let stopping = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let recovery = Promise.resolve();

  const recover = async (): Promise<void> => {
    await recoverOutboxEvents(outboxQueue, outboxStore, config.recoveryBatch);
    await recoverReviewRuns(reviewQueue, {
      listRecoverableReviewRunIds: (limit) =>
        listRecoverableHostedReviewRunIds(pool, limit),
    }, config.recoveryBatch);
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
        reviewQueue.waitUntilReady(),
        outboxWorker.waitUntilReady(),
        reviewWorker.waitUntilReady(),
      ]);
      await recover();
      scheduleRecovery();
    },
    async close() {
      if (stopping) return;
      stopping = true;
      if (recoveryTimer !== undefined) clearTimeout(recoveryTimer);
      await recovery;
      const results = await Promise.allSettled([
        outboxWorker.close(),
        reviewWorker.close(),
      ]);
      const queueResults = await Promise.allSettled([
        outboxQueue.close(),
        reviewQueue.close(),
        pool.end(),
      ]);
      const failures = [...results, ...queueResults]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Hosted worker shutdown failed.');
      }
    },
  };
}
