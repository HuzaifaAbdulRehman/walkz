import { describe, expect, it, vi } from 'vitest';

import {
  claimOutboxEvent,
  createGitHubCheckCompletedOutboxEvent,
  createGitHubCheckQueuedOutboxEvent,
  createOutboxEventStore,
  createReviewRunQueuedOutboxEvent,
  markOutboxEventPublished,
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

  it('stores bounded GitHub check targets without credentials', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'event-id' }] });

    await expect(createGitHubCheckQueuedOutboxEvent({ query }, {
      aggregateId: reviewRunId,
      eventType: 'github_check.queued',
      payload: {
        reviewRunId,
        installationId: '1234',
        owner: 'owner',
        repository: 'repo',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
      },
    })).resolves.toBe('event-id');
    const storedPayload = JSON.parse(query.mock.calls[0]?.[1]?.[2] as string);
    expect(storedPayload).not.toHaveProperty('token');
    expect(storedPayload).toMatchObject({ installationId: '1234', headSha: 'b'.repeat(40) });
  });

  it('stores bounded final check results without source or credentials', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'event-id' }] });
    await expect(createGitHubCheckCompletedOutboxEvent({ query }, {
      aggregateId: reviewRunId,
      eventType: 'github_check.completed',
      payload: {
        reviewRunId,
        installationId: '1234',
        owner: 'owner',
        repository: 'repo',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        verdict: 'SHIP',
        summary: 'No blocking evidence.',
        findings: [],
      },
    })).resolves.toBe('event-id');
    const payload = JSON.parse(query.mock.calls[0]?.[1]?.[2] as string);
    expect(payload).not.toHaveProperty('token');
    expect(payload).not.toHaveProperty('source');
    expect(payload).toMatchObject({ verdict: 'SHIP', findings: [] });
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

  it('claims only an unpublished event with an expired lease', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: 'event-id',
          aggregateId: reviewRunId,
          eventType: 'review_run.queued',
          payload: { reviewRunId },
        },
      ],
    });

    await expect(
      claimOutboxEvent({ query }, {
        eventId: reviewRunId,
        workerId: 'worker-1',
        leaseMs: 30_000,
      }),
    ).resolves.toMatchObject({ id: 'event-id' });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('lease_expires_at <= now()'),
      [reviewRunId, 'worker-1', 30_000],
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      'earlier.aggregate_id = outbox_events.aggregate_id',
    );
    expect(query.mock.calls[0]?.[0]).toContain('(earlier.created_at, earlier.id) <');
  });

  it('marks an event published only for its lease holder', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'event-id' }] });

    await expect(
      markOutboxEventPublished({ query }, {
        eventId: reviewRunId,
        workerId: 'worker-1',
        leaseMs: 30_000,
      }),
    ).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('lease_owner = $2'),
      [reviewRunId, 'worker-1'],
    );
  });

  it('wraps each durable lease operation in a transaction', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const store = createOutboxEventStore({
      connect: vi.fn().mockResolvedValue({ query, release }),
      query: vi.fn(),
    });

    await expect(
      store.claim({ eventId: reviewRunId, workerId: 'worker-1', leaseMs: 30_000 }),
    ).resolves.toBeNull();
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('UPDATE outbox_events'),
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});
