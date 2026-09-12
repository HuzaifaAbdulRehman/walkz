import { describe, expect, it, vi } from 'vitest';

import { createHostedOutboxHandler } from '../src/index.js';

const reviewRunId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const proposalId = 'ed395cbc-3f3f-4702-a3a2-619dd94c93d0';

describe('hosted outbox routing', () => {
  it('enqueues durable review events under the review run ID', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const checks = { handle: vi.fn() };
    const handler = createHostedOutboxHandler({
      checks,
      patchFixes: { add: vi.fn() },
      reviews: { add },
    });
    const event = {
      id: '08d0dd85-734e-4f74-bcfc-3436ec7b4abd',
      aggregateId: reviewRunId,
      eventType: 'review_run.queued',
      payload: { reviewRunId },
    };

    await handler.handle(event, { idempotencyKey: event.id });

    expect(add).toHaveBeenCalledWith(
      'review',
      { reviewRunId },
      expect.objectContaining({ jobId: reviewRunId, removeOnComplete: true }),
    );
    expect(checks.handle).not.toHaveBeenCalled();
  });

  it('delegates only recognized GitHub check events', async () => {
    const checks = { handle: vi.fn().mockResolvedValue(undefined) };
    const handler = createHostedOutboxHandler({
      checks,
      patchFixes: { add: vi.fn() },
      reviews: { add: vi.fn() },
    });
    const event = {
      id: '08d0dd85-734e-4f74-bcfc-3436ec7b4abd',
      aggregateId: reviewRunId,
      eventType: 'github_check.queued',
      payload: {},
    };

    await handler.handle(event, { idempotencyKey: event.id });

    expect(checks.handle).toHaveBeenCalledWith(event, { idempotencyKey: event.id });
  });

  it('rejects unknown events without side effects', async () => {
    const checks = { handle: vi.fn() };
    const reviews = { add: vi.fn() };
    const patchFixes = { add: vi.fn() };
    const handler = createHostedOutboxHandler({ checks, patchFixes, reviews });
    const event = {
      id: '08d0dd85-734e-4f74-bcfc-3436ec7b4abd',
      aggregateId: reviewRunId,
      eventType: 'unknown',
      payload: {},
    };

    await expect(handler.handle(event, { idempotencyKey: event.id })).rejects.toThrow(
      'Unsupported outbox event type.',
    );
    expect(checks.handle).not.toHaveBeenCalled();
    expect(patchFixes.add).not.toHaveBeenCalled();
    expect(reviews.add).not.toHaveBeenCalled();
  });

  it('enqueues approved fixes using only the proposal ID', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const checks = { handle: vi.fn() };
    const handler = createHostedOutboxHandler({
      checks,
      patchFixes: { add },
      reviews: { add: vi.fn() },
    });
    const event = {
      id: '08d0dd85-734e-4f74-bcfc-3436ec7b4abd',
      aggregateId: proposalId,
      eventType: 'patch_fix.queued',
      payload: { proposalId },
    };

    await handler.handle(event, { idempotencyKey: event.id });

    expect(add).toHaveBeenCalledWith(
      'patch-fix',
      { proposalId },
      expect.objectContaining({ jobId: proposalId }),
    );
    expect(checks.handle).not.toHaveBeenCalled();
  });
});
