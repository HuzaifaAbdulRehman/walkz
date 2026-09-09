import { describe, expect, it, vi } from 'vitest';

import { listReviewFindings } from '../src/index.js';

const repositoryId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const reviewRunId = '08d0dd85-734e-4f74-bcfc-3436ec7b4abd';

describe('review finding persistence', () => {
  it('scopes the bounded result to one repository and run', async () => {
    const row = {
      fingerprint: 'a'.repeat(64),
      category: 'correctness',
      severity: 'high',
      path: 'src/value.ts',
      startLine: 8,
      endLine: 9,
      lifecycleStatus: 'verified',
      evidenceLevel: 'VERIFIED',
      advisoryConfidence: 0.93,
      summary: 'The value can be stale.',
      claim: 'The value can be stale.',
      failureMechanism: 'The cache key omits the current revision.',
      suggestedProof: 'Request both revisions with the same key.',
      createdAt: new Date('2026-09-10T00:00:00.000Z'),
    };
    const query = vi.fn().mockResolvedValue({ rows: [row] });

    await expect(listReviewFindings({ query }, {
      repositoryId,
      reviewRunId,
    })).resolves.toEqual([row]);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain('JOIN review_runs rr ON rr.id = f.review_run_id');
    expect(sql).toContain('rr.repository_id = $1');
    expect(sql).toContain('f.review_run_id = $2');
    expect(sql).toContain('LIMIT 50');
    expect(query).toHaveBeenCalledWith(expect.any(String), [repositoryId, reviewRunId]);
    expect(sql).not.toContain('prompt');
    expect(sql).not.toContain('response');
  });
});
