import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createOutboxEventStore,
  createReviewRunQueuedOutboxEvent,
  withTransaction,
} from '../src/index.js';

const databaseUrl = process.env.WALKZ_POSTGRES_TEST_URL;
const integration = databaseUrl === undefined ? it.skip : it;
const pools: Pool[] = [];

function createTestPool(): Pool {
  if (databaseUrl === undefined) {
    throw new Error('WALKZ_POSTGRES_TEST_URL is required.');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe('PostgreSQL outbox leases', () => {
  integration('allows one lease holder to publish an event exactly once', async () => {
    const pool = createTestPool();
    const store = createOutboxEventStore(pool);
    const reviewRunId = randomUUID();
    const eventId = await withTransaction(pool, (client) =>
      createReviewRunQueuedOutboxEvent(client, {
        aggregateId: reviewRunId,
        eventType: 'review_run.queued',
        payload: { reviewRunId },
      }),
    );

    await expect(
      store.claim({ eventId, workerId: 'worker-one', leaseMs: 30_000 }),
    ).resolves.toMatchObject({ id: eventId });
    await expect(
      store.claim({ eventId, workerId: 'worker-two', leaseMs: 30_000 }),
    ).resolves.toBeNull();
    await expect(
      store.markPublished({ eventId, workerId: 'worker-two', leaseMs: 30_000 }),
    ).resolves.toBe(false);
    await expect(
      store.markPublished({ eventId, workerId: 'worker-one', leaseMs: 30_000 }),
    ).resolves.toBe(true);
    await expect(
      store.claim({ eventId, workerId: 'worker-two', leaseMs: 30_000 }),
    ).resolves.toBeNull();
  });
});
