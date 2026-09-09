import { describe, expect, it, vi } from 'vitest';

import { createReviewCheckPublisher } from '../src/index.js';

const payload = {
  name: 'Walkz / review',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  status: 'completed' as const,
  conclusion: 'success' as const,
  summary: 'No blocking findings.',
  annotations: [],
};

describe('GitHub review check publisher', () => {
  it('publishes validated checks with the exact head SHA', async () => {
    const create = vi.fn().mockResolvedValue({ id: 42 });
    const findByExternalId = vi.fn().mockResolvedValue(null);
    const update = vi.fn();
    const publisher = createReviewCheckPublisher({ create, findByExternalId, update });

    await expect(
      publisher.publish({ owner: 'owner', repository: 'repo' }, payload, 'review-run-1'),
    ).resolves.toBe(42);
    expect(findByExternalId).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      name: 'Walkz / review',
      headSha: payload.headSha,
      externalId: 'review-run-1',
    });
    expect(create).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      name: 'Walkz / review',
      headSha: payload.headSha,
      status: 'completed',
      conclusion: 'success',
      summary: 'No blocking findings.',
      annotations: [],
      externalId: 'review-run-1',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('updates the existing check for a retried review run', async () => {
    const create = vi.fn();
    const findByExternalId = vi.fn().mockResolvedValue({ id: 42 });
    const update = vi.fn().mockResolvedValue({ id: 42 });
    const publisher = createReviewCheckPublisher({ create, findByExternalId, update });

    await expect(
      publisher.publish({ owner: 'owner', repository: 'repo' }, payload, 'review-run-1'),
    ).resolves.toBe(42);
    expect(update).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      checkRunId: 42,
      name: 'Walkz / review',
      status: 'completed',
      conclusion: 'success',
      summary: 'No blocking findings.',
      annotations: [],
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('does not call GitHub for invalid check data', async () => {
    const create = vi.fn();
    const findByExternalId = vi.fn();
    const update = vi.fn();
    const publisher = createReviewCheckPublisher({ create, findByExternalId, update });

    await expect(
      publisher.publish({ owner: 'owner', repository: 'repo' }, {
        ...payload,
        headSha: 'not-a-sha',
      }, 'review-run-1'),
    ).rejects.toThrow();
    expect(findByExternalId).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
