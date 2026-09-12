import { describe, expect, it, vi } from 'vitest';

import { loadLatestVerifiedPatchFixSourceForPullRequest } from '../src/index.js';

describe('latest verified patch fix source', () => {
  it('selects the newest current run before its highest-severity finding', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(loadLatestVerifiedPatchFixSourceForPullRequest({ query }, {
      repositoryId: '99516fcb-ec21-4a50-8936-d585e77ca154',
      pullRequestNumber: 29,
    })).resolves.toBeNull();

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("rr.status = 'awaiting_human'");
    expect(sql).toContain('pr.head_sha = rr.head_sha');
    expect(sql).toContain("f.evidence_level = 'VERIFIED'");
    expect(sql).toContain("evidence.base_outcome = 'passed'");
    expect(sql).toContain("evidence.head_outcome = 'failed'");
    expect(sql.indexOf('rr.created_at DESC')).toBeLessThan(
      sql.indexOf("WHEN 'critical' THEN 4"),
    );
  });
});
