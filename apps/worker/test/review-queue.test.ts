import { describe, expect, it, vi } from 'vitest';

import { enqueueReviewRun } from '../src/index.js';
import { recoverReviewRuns } from '../src/index.js';

describe('review queue', () => {
  it('uses the review run as the stable BullMQ job ID', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const reviewRunId = '3d963b52-8203-4ba6-bcac-15bf132371f0';

    await enqueueReviewRun({ add }, reviewRunId);

    expect(add).toHaveBeenCalledWith(
      'review',
      { reviewRunId },
      {
        jobId: reviewRunId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  });

  it('restores PostgreSQL-owned runs to disposable Redis state', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const reviewRunId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
    const listRecoverableReviewRunIds = vi.fn().mockResolvedValue([reviewRunId]);

    await expect(recoverReviewRuns(
      { add },
      { listRecoverableReviewRunIds },
      100,
    )).resolves.toBe(1);
    expect(listRecoverableReviewRunIds).toHaveBeenCalledWith(100);
    expect(add).toHaveBeenCalledWith(
      'review',
      { reviewRunId },
      expect.objectContaining({ jobId: reviewRunId, removeOnFail: true }),
    );
  });

  it('rejects malformed run IDs before touching Redis', async () => {
    const add = vi.fn();

    await expect(enqueueReviewRun({ add }, 'not-a-uuid')).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });
});
