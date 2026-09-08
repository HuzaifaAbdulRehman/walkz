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
    const publisher = createReviewCheckPublisher({ create });

    await expect(
      publisher.publish({ owner: 'owner', repository: 'repo' }, payload),
    ).resolves.toBe(42);
    expect(create).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      name: 'Walkz / review',
      headSha: payload.headSha,
      status: 'completed',
      conclusion: 'success',
      summary: 'No blocking findings.',
      annotations: [],
    });
  });

  it('does not call GitHub for invalid check data', async () => {
    const create = vi.fn();
    const publisher = createReviewCheckPublisher({ create });

    await expect(
      publisher.publish({ owner: 'owner', repository: 'repo' }, {
        ...payload,
        headSha: 'not-a-sha',
      }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
