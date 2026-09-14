import type { ConnectionOptions } from 'bullmq';
import {
  createDatabasePool,
  createOutboxEventStore,
  listRecoverableGitHubCommentCommandIds,
  listRecoverableHostedReviewRunIds,
  listRecoverablePatchFixProposalIds,
} from '@walkz/persistence';
import { z } from 'zod';

import {
  createCommentCommandQueue,
  recoverCommentCommands,
} from './comment-command-queue.js';
import {
  createOutboxQueue,
  recoverOutboxEvents,
} from './index.js';
import {
  createPatchFixQueue,
  recoverPatchFixes,
} from './patch-fix-queue.js';
import {
  createReviewQueue,
  recoverReviewRuns,
} from './review-queue.js';

const environmentSchema = z.object({
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  WALKZ_RECOVERY_BATCH: z.coerce.number().int().min(1).max(1_000).default(100),
}).passthrough();

export interface DurableRecoveryResult {
  outbox: number;
  commentCommands: number;
  reviews: number;
  patchFixes: number;
}

export interface DurableRecoveryQueues {
  outbox: Parameters<typeof recoverOutboxEvents>[0];
  commentCommands: Parameters<typeof recoverCommentCommands>[0];
  reviews: Parameters<typeof recoverReviewRuns>[0];
  patchFixes: Parameters<typeof recoverPatchFixes>[0];
}

export interface DurableRecoveryStores {
  outbox: Parameters<typeof recoverOutboxEvents>[1];
  commentCommands: Parameters<typeof recoverCommentCommands>[1];
  reviews: Parameters<typeof recoverReviewRuns>[1];
  patchFixes: Parameters<typeof recoverPatchFixes>[1];
}

export async function recoverDurableWork(
  queues: DurableRecoveryQueues,
  stores: DurableRecoveryStores,
  limit: number,
): Promise<DurableRecoveryResult> {
  const outbox = await recoverOutboxEvents(queues.outbox, stores.outbox, limit);
  const commentCommands = await recoverCommentCommands(
    queues.commentCommands,
    stores.commentCommands,
    limit,
  );
  const reviews = await recoverReviewRuns(queues.reviews, stores.reviews, limit);
  const patchFixes = await recoverPatchFixes(
    queues.patchFixes,
    stores.patchFixes,
    limit,
  );
  return { outbox, commentCommands, reviews, patchFixes };
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
    !['redis:', 'rediss:'].includes(url.protocol) ||
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
    port: url.port.length > 0 ? Number(url.port) : 6379,
    db: database,
    ...(url.username.length > 0 ? { username: decodeRedisPart(url.username) } : {}),
    ...(url.password.length > 0 ? { password: decodeRedisPart(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: { servername: url.hostname } } : {}),
    maxRetriesPerRequest: null,
  };
}

export async function recoverDurableWorkFromEnvironment(
  environment: NodeJS.ProcessEnv,
): Promise<DurableRecoveryResult> {
  const config = environmentSchema.parse(environment);
  const redis = parseRedisConnection(config.REDIS_URL);
  const pool = createDatabasePool({
    connectionString: config.DATABASE_URL,
    maxConnections: 2,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 10_000,
  });
  const queues = {
    outbox: createOutboxQueue(redis),
    commentCommands: createCommentCommandQueue(redis),
    reviews: createReviewQueue(redis),
    patchFixes: createPatchFixQueue(redis),
  };
  try {
    await Promise.all(Object.values(queues).map((queue) => queue.waitUntilReady()));
    return await recoverDurableWork(queues, {
      outbox: createOutboxEventStore(pool),
      commentCommands: {
        listRecoverableGitHubCommentCommandIds: (limit) =>
          listRecoverableGitHubCommentCommandIds(pool, limit),
      },
      reviews: {
        listRecoverableReviewRunIds: (limit) =>
          listRecoverableHostedReviewRunIds(pool, limit),
      },
      patchFixes: {
        listRecoverablePatchFixProposalIds: (limit) =>
          listRecoverablePatchFixProposalIds(pool, limit),
      },
    }, config.WALKZ_RECOVERY_BATCH);
  } finally {
    await Promise.allSettled([
      ...Object.values(queues).map((queue) => queue.close()),
      pool.end(),
    ]);
  }
}
