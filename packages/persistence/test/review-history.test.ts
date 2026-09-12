import { describe, expect, it, vi } from 'vitest';

import { listReviewHistory } from '../src/index.js';

describe('review history persistence', () => {
  it('returns only safe review lifecycle fields with a bounded limit', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'run-id', status: 'completed' }] });

    await expect(listReviewHistory({ query }, {
      repositoryId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
      limit: 25,
    })).resolves.toEqual([{ id: 'run-id', status: 'completed' }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $2'), [
      '3d963b52-8203-4ba6-bcac-15bf132371f0',
      25,
    ]);
    expect(query.mock.calls[0]?.[0]).not.toContain('prompt');
    expect(query.mock.calls[0]?.[0]).not.toContain('response');
    expect(query.mock.calls[0]?.[0]).toContain('verdict');
    expect(query.mock.calls[0]?.[0]).toContain('result_summary AS "resultSummary"');
    expect(query.mock.calls[0]?.[0]).toContain('pr.number AS "pullRequestNumber"');
    expect(query.mock.calls[0]?.[0]).toContain('LEFT JOIN pull_requests pr');
  });
});
