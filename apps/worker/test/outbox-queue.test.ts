import { describe, expect, it, vi } from 'vitest';

import { enqueueOutboxEvent } from '../src/index.js';

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
});
