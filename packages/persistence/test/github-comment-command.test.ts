import { describe, expect, it, vi } from 'vitest';

import {
  claimReviewCommentCommand,
  completeGitHubCommentCommand,
  failGitHubCommentCommand,
  listRecoverableReviewCommentCommandIds,
  releaseGitHubCommentCommand,
  renewGitHubCommentCommandLease,
} from '../src/index.js';

const commandId = '9058b3c9-3243-43b3-b0d8-dd692ece130f';
const reviewRunId = '4a14bcbf-d2cf-49b1-9144-c0a16e5722f6';
const lease = { commandId, workerId: 'worker-1', leaseMs: 60_000 };

function claimedRow() {
  return {
    commandId,
    repositoryId: '99516fcb-ec21-4a50-8936-d585e77ca154',
    installationId: '1234',
    repositoryGitHubId: '5678',
    owner: 'owner',
    repository: 'repo',
    commentId: '44',
    commenterId: '55',
    commenterLogin: 'maintainer',
    pullRequestNumber: 29,
    command: 'review',
    attempt: 1,
  };
}

describe('GitHub review comment command persistence', () => {
  it('claims only review commands with an available durable lease', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [claimedRow()] });

    await expect(claimReviewCommentCommand({ query }, lease))
      .resolves.toEqual(claimedRow());

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("gcc.command = 'review'");
    expect(sql).toContain('gcc.attempt < 5');
    expect(sql).toContain('gcc.lease_expires_at <= now()');
  });

  it('renews and releases only a lease owned by the worker', async () => {
    const renew = vi.fn().mockResolvedValue({ rows: [{ id: commandId }] });
    const release = vi.fn().mockResolvedValue({ rows: [{ id: commandId }] });

    await expect(renewGitHubCommentCommandLease({ query: renew }, lease))
      .resolves.toBe(true);
    await expect(releaseGitHubCommentCommand({ query: release }, {
      commandId,
      workerId: 'worker-1',
    }))
      .resolves.toBe(true);

    expect(String(renew.mock.calls[0]?.[0])).toContain("status = 'processing'");
    expect(String(release.mock.calls[0]?.[0])).toContain("status = 'queued'");
  });

  it('binds a completed command to its review run and reply', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: commandId }] });

    await expect(completeGitHubCommentCommand({ query }, {
      commandId,
      workerId: 'worker-1',
      status: 'completed',
      replyUrl: 'https://github.com/owner/repo/pull/29#issuecomment-77',
      reviewRunId,
    })).resolves.toBe(true);

    expect(query.mock.calls[0]?.[1]).toEqual([
      commandId,
      'worker-1',
      'completed',
      'https://github.com/owner/repo/pull/29#issuecomment-77',
      reviewRunId,
    ]);
  });

  it('requires a review run before completing a review command', async () => {
    const query = vi.fn();

    await expect(completeGitHubCommentCommand({ query }, {
      commandId,
      workerId: 'worker-1',
      status: 'completed',
      replyUrl: 'https://github.com/owner/repo/pull/29#issuecomment-77',
      reviewRunId: null,
    })).rejects.toThrow('require a review run ID');
    expect(query).not.toHaveBeenCalled();
  });

  it('records a terminal failure only while the worker owns the command', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: commandId }] });

    await expect(failGitHubCommentCommand({ query }, {
      commandId,
      workerId: 'worker-1',
    })).resolves.toBe(true);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("failure_code = 'workflow_failed'");
    expect(sql).toContain('lease_owner = $2');
  });

  it('recovers only review commands below the retry cap', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ commandId }] });

    await expect(listRecoverableReviewCommentCommandIds({ query }, 50))
      .resolves.toEqual([commandId]);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("command = 'review'");
    expect(sql).toContain('attempt < 5');
  });
});
