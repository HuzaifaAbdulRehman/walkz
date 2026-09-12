import { describe, expect, it, vi } from 'vitest';

import { enqueuePatchFix, recoverPatchFixes } from '../src/index.js';

const proposalId = 'ed395cbc-3f3f-4702-a3a2-619dd94c93d0';

describe('patch fix queue', () => {
  it('uses the proposal as the stable BullMQ job ID', async () => {
    const add = vi.fn().mockResolvedValue(undefined);

    await enqueuePatchFix({ add }, proposalId);

    expect(add).toHaveBeenCalledWith('patch-fix', { proposalId }, {
      jobId: proposalId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1_000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  });

  it('restores PostgreSQL-owned fixes to disposable Redis state', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const listRecoverablePatchFixProposalIds = vi.fn().mockResolvedValue([proposalId]);

    await expect(recoverPatchFixes(
      { add },
      { listRecoverablePatchFixProposalIds },
      100,
    )).resolves.toBe(1);
    expect(add).toHaveBeenCalledWith(
      'patch-fix',
      { proposalId },
      expect.objectContaining({ jobId: proposalId, removeOnFail: true }),
    );
  });

  it('rejects malformed proposal IDs before touching Redis', async () => {
    const add = vi.fn();

    await expect(enqueuePatchFix({ add }, 'not-a-uuid')).rejects.toThrow();
    expect(add).not.toHaveBeenCalled();
  });
});
