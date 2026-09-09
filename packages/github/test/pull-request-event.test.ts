import { describe, expect, it } from 'vitest';

import { parsePullRequestReviewTrigger } from '../src/index.js';

const event = {
  action: 'ready_for_review',
  installation: { id: 1234, extra: 'ignored' },
  repository: {
    id: 5678,
    name: 'walkz',
    owner: { login: 'HuzaifaAbdulRehman', extra: 'ignored' },
    private: true,
  },
  pull_request: {
    id: 9012,
    number: 7,
    base: { sha: 'a'.repeat(40), ref: 'main' },
    head: { sha: 'b'.repeat(40), ref: 'feature' },
    title: 'Test pull request',
  },
  sender: { login: 'developer' },
};

describe('pull request review events', () => {
  it('extracts an exact-SHA ready-for-review trigger', () => {
    expect(parsePullRequestReviewTrigger(event)).toEqual({
      trigger: 'ready_for_review',
      installationId: '1234',
      repositoryId: '5678',
      repositoryOwner: 'HuzaifaAbdulRehman',
      repositoryName: 'walkz',
      pullRequestId: '9012',
      pullRequestNumber: 7,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    });
  });

  it('ignores closed pull requests', () => {
    expect(parsePullRequestReviewTrigger({ ...event, action: 'closed' })).toBeNull();
  });

  it('ignores unrelated pull request actions', () => {
    expect(parsePullRequestReviewTrigger({ ...event, action: 'assigned' })).toBeNull();
  });

  it('rejects identifiers that cannot be represented safely', () => {
    expect(() => parsePullRequestReviewTrigger({
      ...event,
      repository: { ...event.repository, id: Number.MAX_SAFE_INTEGER + 1 },
    })).toThrow();
  });
});
