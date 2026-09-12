import { describe, expect, it, vi } from 'vitest';

import {
  submitPatchDecision,
  submitStoredPatchDecision,
} from './patch-fix-actions.js';

const repositoryId = '99516fcb-ec21-4a50-8936-d585e77ca154';
const proposalId = 'ed395cbc-3f3f-4702-a3a2-619dd94c93d0';
const candidate = {
  schemaVersion: 1 as const,
  proposalId,
  reviewRunId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
  findingId: '2d437195-a9f0-4af9-aaf4-3cbda1c8f61f',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  deliveryMode: 'suggestion' as const,
  path: 'src/value.ts',
  startLine: 3,
  endLine: 3,
  replacement: 'return safe;',
  approvalRequired: true as const,
  originalHash: 'c'.repeat(64),
  patchHash: 'd'.repeat(64),
};

describe('patch fix dashboard actions', () => {
  it('publishes the exact transient candidate after approval', async () => {
    const fetchAction = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });

    await submitPatchDecision(fetchAction, repositoryId, candidate, 'approved');

    expect(fetchAction).toHaveBeenCalledTimes(2);
    expect(fetchAction.mock.calls[0]?.[0]).toContain('/publish-suggestion');
    expect(fetchAction.mock.calls[1]?.[0]).toContain('/decision');
    expect(JSON.parse(String(fetchAction.mock.calls[0]?.[1].body)))
      .toEqual({ candidate: expect.objectContaining({
        replacement: candidate.replacement,
        patchHash: candidate.patchHash,
        originalHash: candidate.originalHash,
      }) });
  });

  it('does not publish rejected content', async () => {
    const fetchAction = vi.fn().mockResolvedValue({ ok: true });

    await submitPatchDecision(fetchAction, repositoryId, candidate, 'rejected');

    expect(fetchAction).toHaveBeenCalledOnce();
  });

  it('resumes approval from a durable GitHub suggestion reference', async () => {
    const fetchAction = vi.fn().mockResolvedValue({ ok: true });

    await submitStoredPatchDecision(
      fetchAction,
      repositoryId,
      proposalId,
      candidate.patchHash,
      candidate.headSha,
      'approved',
    );

    expect(fetchAction).toHaveBeenCalledOnce();
    expect(fetchAction.mock.calls[0]?.[0]).toContain('/decision');
  });
});
