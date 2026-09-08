import { describe, expect, it } from 'vitest';

import { parseReviewCheckPayload } from '../src/index.js';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);

describe('GitHub review checks', () => {
  it('accepts bounded in-progress and completed payloads', () => {
    expect(parseReviewCheckPayload({
      name: 'Walkz / review',
      baseSha: base,
      headSha: head,
      status: 'completed',
      conclusion: 'failure',
      summary: 'One verified finding blocks this review.',
      annotations: [{
        path: 'src/index.ts',
        startLine: 4,
        endLine: 4,
        level: 'failure',
        message: 'Verified regression.',
      }],
    }).annotations).toHaveLength(1);
  });

  it('rejects incomplete conclusions and unbounded annotation batches', () => {
    expect(() => parseReviewCheckPayload({
      name: 'Walkz / review',
      baseSha: base,
      headSha: head,
      status: 'completed',
      conclusion: null,
      summary: 'pending',
      annotations: [],
    })).toThrow('conclusion');
    expect(() => parseReviewCheckPayload({
      name: 'Walkz / review',
      baseSha: base,
      headSha: head,
      status: 'in_progress',
      conclusion: null,
      summary: 'pending',
      annotations: Array.from({ length: 51 }, () => ({
        path: 'src/index.ts',
        startLine: 1,
        endLine: 1,
        level: 'notice',
        message: 'note',
      })),
    })).toThrow();
  });
});
