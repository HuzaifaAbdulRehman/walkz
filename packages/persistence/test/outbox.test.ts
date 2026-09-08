import { describe, expect, it, vi } from 'vitest';

import {
  createReviewRunQueuedOutboxEvent,
  withTransaction,
} from '../src/index.js';

const reviewRunId = '3d963b52-8203-4ba6-bcac-15bf132371f0';

describe('transactional outbox', () => {
  it('commits an outbox event in the caller transaction', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'event-id' }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(
      withTransaction(pool, (client) =>
        createReviewRunQueuedOutboxEvent(client, {
          aggregateId: reviewRunId,
          eventType: 'review_run.queued',
          payload: { reviewRunId },
        }),
      ),
    ).resolves.toBe('event-id');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO outbox_events'),
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases a failed transaction', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(
      withTransaction(pool, (client) =>
        createReviewRunQueuedOutboxEvent(client, {
          aggregateId: reviewRunId,
          eventType: 'review_run.queued',
          payload: { reviewRunId },
        }),
      ),
    ).rejects.toThrow('insert failed');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO outbox_events'),
      'ROLLBACK',
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});
