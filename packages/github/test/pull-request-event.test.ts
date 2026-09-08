import { describe, expect, it } from 'vitest';

import { parsePullRequestReviewTrigger } from '../src/index.js';

const event = {
  action: 'ready_for_review',
  pull_request: {
    number: 7,
    base: { sha: 'a'.repeat(40) },
    head: { sha: 'b'.repeat(40) },
  },
};

describe('pull request review events', () => {
  it('extracts an exact-SHA ready-for-review trigger', () => {
    expect(parsePullRequestReviewTrigger(event)).toEqual({
      trigger: 'ready_for_review',
      pullRequestNumber: 7,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    });
  });

  it('ignores closed pull requests', () => {
    expect(parsePullRequestReviewTrigger({ ...event, action: 'closed' })).toBeNull();
  });
});
