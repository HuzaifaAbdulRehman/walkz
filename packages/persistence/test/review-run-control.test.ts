import { describe, expect, it, vi } from 'vitest';

import {
  cancelReviewRun,
  supersedeActiveReviewRuns,
} from '../src/index.js';

const runId = '3d963b52-8203-4ba6-bcac-15bf132371f0';

describe('review run control', () => {
  it('cancels only active runs', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: runId }] });

    await expect(cancelReviewRun({ query }, runId)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'cancelled'"),
      [runId, expect.arrayContaining(['queued', 'reproving'])],
    );
  });

  it('supersedes active siblings without touching terminal runs', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: runId }] });
    const replacementRunId = '08d0dd85-734e-4f74-bcfc-3436ec7b4abd';

    await expect(
      supersedeActiveReviewRuns({ query }, {
        pullRequestId: '09e7392c-03bb-4b34-b099-0803fb0d9023',
        replacementRunId,
      }),
    ).resolves.toEqual([runId]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'superseded'"),
      [
        '09e7392c-03bb-4b34-b099-0803fb0d9023',
        replacementRunId,
        expect.arrayContaining(['queued', 'reproving']),
      ],
    );
  });
});
