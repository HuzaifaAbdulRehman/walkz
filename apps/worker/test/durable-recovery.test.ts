import { describe, expect, it, vi } from 'vitest';

import { recoverDurableWork } from '../src/durable-recovery.js';

describe('durable queue recovery', () => {
  it('reconciles each durable source into its disposable queue', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const queues = {
      outbox: { add },
      commentCommands: { add },
      reviews: { add },
      patchFixes: { add },
    };
    const stores = {
      outbox: {
        listRecoverableEventIds: vi.fn().mockResolvedValue([
          '10000000-0000-4000-8000-000000000001',
        ]),
      },
      commentCommands: {
        listRecoverableGitHubCommentCommandIds: vi.fn().mockResolvedValue([
          '20000000-0000-4000-8000-000000000002',
        ]),
      },
      reviews: {
        listRecoverableReviewRunIds: vi.fn().mockResolvedValue([
          '30000000-0000-4000-8000-000000000003',
        ]),
      },
      patchFixes: {
        listRecoverablePatchFixProposalIds: vi.fn().mockResolvedValue([
          '40000000-0000-4000-8000-000000000004',
        ]),
      },
    };

    await expect(recoverDurableWork(queues, stores, 25)).resolves.toEqual({
      outbox: 1,
      commentCommands: 1,
      reviews: 1,
      patchFixes: 1,
    });
    for (const store of Object.values(stores)) {
      expect(Object.values(store)[0]).toHaveBeenCalledWith(25);
    }
    expect(add).toHaveBeenCalledTimes(4);
  });

  it('fails when any durable source cannot be reconciled', async () => {
    const unavailable = new Error('database unavailable');
    await expect(recoverDurableWork({
      outbox: { add: vi.fn() },
      commentCommands: { add: vi.fn() },
      reviews: { add: vi.fn() },
      patchFixes: { add: vi.fn() },
    }, {
      outbox: { listRecoverableEventIds: vi.fn().mockRejectedValue(unavailable) },
      commentCommands: {
        listRecoverableGitHubCommentCommandIds: vi.fn().mockResolvedValue([]),
      },
      reviews: { listRecoverableReviewRunIds: vi.fn().mockResolvedValue([]) },
      patchFixes: {
        listRecoverablePatchFixProposalIds: vi.fn().mockResolvedValue([]),
      },
    }, 10)).rejects.toThrow('database unavailable');
  });
});
