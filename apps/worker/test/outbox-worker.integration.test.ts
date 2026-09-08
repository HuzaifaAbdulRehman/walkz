import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createOutboxQueue,
  createOutboxWorker,
  enqueueOutboxEvent,
} from '../src/index.js';

const redisUrl = process.env.WALKZ_REDIS_TEST_URL;
const integration = redisUrl === undefined ? it.skip : it;
const closers: Array<() => Promise<void>> = [];

function redisConnection() {
  if (redisUrl === undefined) {
    throw new Error('WALKZ_REDIS_TEST_URL is required.');
  }
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || '6379'),
  };
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('BullMQ outbox worker', () => {
  integration('dispatches a Redis job with the event ID as its idempotency key', async () => {
    const event = {
      id: '3d963b52-8203-4ba6-bcac-15bf132371f0',
      aggregateId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
      eventType: 'review_run.queued',
      payload: { reviewRunId: '3d963b52-8203-4ba6-bcac-15bf132371f0' },
    };
    const store = {
      claim: vi.fn().mockResolvedValue(event),
      markPublished: vi.fn().mockResolvedValue(true),
      listRecoverableEventIds: vi.fn().mockResolvedValue([]),
    };
    const handler = { handle: vi.fn().mockResolvedValue(undefined) };
    const connection = redisConnection();
    const queue = createOutboxQueue(connection);
    const worker = createOutboxWorker(connection, store, handler, {
      workerId: 'integration-worker',
      leaseMs: 30_000,
    });
    closers.push(() => worker.close());
    closers.push(() => queue.close());

    const completed = new Promise<void>((resolve, reject) => {
      worker.once('completed', () => resolve());
      worker.once('failed', (_job, error) => reject(error));
    });
    await enqueueOutboxEvent(queue, event.id);
    await completed;

    expect(handler.handle).toHaveBeenCalledWith(event, {
      idempotencyKey: event.id,
    });
    expect(store.markPublished).toHaveBeenCalledOnce();
  }, 15_000);
});
