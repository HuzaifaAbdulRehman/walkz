import { describe, expect, it, vi } from 'vitest';

import {
  createOutboxQueue,
  dispatchOutboxEvent,
  enqueueOutboxEvent,
} from '../src/index.js';

describe('outbox queue', () => {
  it('uses the outbox ID as the stable job ID', async () => {
    const add = vi.fn().mockResolvedValue(undefined);

    await enqueueOutboxEvent({ add }, 'event-id');

    expect(add).toHaveBeenCalledWith(
      'dispatch',
      { eventId: 'event-id' },
      { jobId: 'event-id' },
    );
  });

  it('uses one named queue for all outbox dispatches', async () => {
    const queue = createOutboxQueue({ host: '127.0.0.1', port: 1 });

    expect(queue.name).toBe('walkz-outbox');
    await queue.close();
  });

  it('marks an event published only after its idempotent handler succeeds', async () => {
    const event = {
      id: 'event-id',
      aggregateId: 'run-id',
      eventType: 'review_run.queued',
      payload: { reviewRunId: 'run-id' },
    };
    const store = {
      claim: vi.fn().mockResolvedValue(event),
      markPublished: vi.fn().mockResolvedValue(true),
    };
    const handler = { handle: vi.fn().mockResolvedValue(undefined) };

    await expect(
      dispatchOutboxEvent(store, handler, {
        eventId: 'event-id',
        workerId: 'worker-1',
        leaseMs: 30_000,
      }),
    ).resolves.toBe('published');
    expect(handler.handle).toHaveBeenCalledWith(event, {
      idempotencyKey: 'event-id',
    });
    expect(store.markPublished).toHaveBeenCalledAfter(handler.handle);
  });
});
