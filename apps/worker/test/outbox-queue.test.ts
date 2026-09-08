import { describe, expect, it, vi } from 'vitest';

import { createOutboxQueue, enqueueOutboxEvent } from '../src/index.js';

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
});
