import { describe, expect, it } from 'vitest';

import { buildReviewCheckPayload } from '../src/index.js';

describe('review result check mapping', () => {
  it('maps a SHIP result to a successful exact-SHA check', () => {
    const check = buildReviewCheckPayload({
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      verdict: 'SHIP',
      summary: 'Checks passed.',
      findings: [],
    });

    expect(check).toMatchObject({
      name: 'Walkz / review',
      conclusion: 'success',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    });
  });

  it('maps blocking findings to bounded failure annotations', () => {
    const check = buildReviewCheckPayload({
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      verdict: 'FIX',
      summary: 'Verified regression.',
      findings: [{
        path: 'src/index.ts',
        startLine: 4,
        endLine: 4,
        severity: 'critical',
        summary: 'Base passes and head fails.',
      }],
    });

    expect(check.conclusion).toBe('failure');
    expect(check.annotations[0]?.level).toBe('failure');
  });
});
