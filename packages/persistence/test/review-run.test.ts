import { describe, expect, it, vi } from 'vitest';

import { createQueuedReviewRun } from '../src/index.js';

const input = {
  repositoryId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
  pullRequestId: null,
  configId: '08d0dd85-734e-4f74-bcfc-3436ec7b4abd',
  configHash: 'a'.repeat(64),
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  provider: 'groq',
  model: 'model',
  promptVersion: 'v1',
};

describe('queued review runs', () => {
  it('commits the run and its outbox event together', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: input.repositoryId }] })
      .mockResolvedValueOnce({ rows: [{ id: input.configId }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(createQueuedReviewRun(pool, input)).resolves.toEqual({
      reviewRunId: input.repositoryId,
      outboxEventId: input.configId,
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO review_runs'),
      expect.stringContaining('INSERT INTO outbox_events'),
      'COMMIT',
    ]);
  });
});
