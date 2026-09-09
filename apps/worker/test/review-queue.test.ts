import { describe, expect, it, vi } from 'vitest';

import { enqueueReviewRun } from '../src/index.js';

describe('review queue', () => {
  it('uses the review run as the stable BullMQ job ID', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const reviewRunId = '3d963b52-8203-4ba6-bcac-15bf132371f0';

    await enqueueReviewRun({ add }, reviewRunId);

    expect(add).toHaveBeenCalledWith(
      'review',
      { reviewRunId },
      { jobId: reviewRunId },
    );
  });

  it('rejects malformed run IDs before touching Redis', async () => {
    const add = vi.fn();

    await expect(enqueueReviewRun({ add }, 'not-a-uuid')).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });
});
