import { describe, expect, it, vi } from 'vitest';

import { createGitHubCommentCommandJobHandler } from '../src/index.js';

const commandId = '9058b3c9-3243-43b3-b0d8-dd692ece130f';
const reviewRunId = '4a14bcbf-d2cf-49b1-9144-c0a16e5722f6';
const proposalId = 'ed395cbc-3f3f-4702-a3a2-619dd94c93d0';
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);

function command(attempt = 1) {
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
    command: 'review' as const,
    patchProposalId: null,
    proposalReviewRunId: null,
    proposalHeadSha: null,
    attempt,
  };
}

function dependencies(attempt = 1) {
  const client = {
    canMaintain: vi.fn().mockResolvedValue(true),
    publishReply: vi.fn().mockResolvedValue({
      commentId: '77',
      url: 'https://github.com/owner/repo/pull/29#issuecomment-77',
      reused: false,
    }),
  };
  const reader = {
    get: vi.fn().mockResolvedValue({
      githubId: '999',
      number: 29,
      repositoryGitHubId: '5678',
      repositoryOwner: 'owner',
      repositoryName: 'repo',
      baseSha,
      headSha,
      draft: false,
    }),
  };
  const store = {
    claim: vi.fn().mockResolvedValue(command(attempt)),
    renew: vi.fn().mockResolvedValue(true),
    queueReview: vi.fn().mockResolvedValue({ reviewRunId }),
    complete: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(true),
  };
  const proposals = { prepare: vi.fn().mockResolvedValue(null) };
  const handler = createGitHubCommentCommandJobHandler({
    store,
    comments: { forInstallation: vi.fn().mockResolvedValue(client) },
    pullRequests: { forInstallation: vi.fn().mockResolvedValue(reader) },
    proposals,
    workerId: 'worker-1',
    leaseMs: 60_000,
    promptVersion: 'walkz-review-v1',
    dashboardUrl: 'https://walkz.example/',
  });
  return { client, handler, proposals, reader, store };
}

describe('GitHub review comment command handler', () => {
  it('authorizes, binds exact PR SHAs, queues once, and replies', async () => {
    const { client, handler, store } = dependencies();

    await handler.handle(commandId);

    expect(client.canMaintain).toHaveBeenCalledWith({
      owner: 'owner',
      repository: 'repo',
      username: 'maintainer',
    });
    expect(store.queueReview).toHaveBeenCalledWith({
      requestId: commandId,
      repositoryId: '99516fcb-ec21-4a50-8936-d585e77ca154',
      installationId: '1234',
      githubId: '5678',
      owner: 'owner',
      repository: 'repo',
      pullRequestId: '999',
      pullRequestNumber: 29,
      baseSha,
      headSha,
      promptVersion: 'walkz-review-v1',
    });
    expect(client.publishReply).toHaveBeenCalledWith(expect.objectContaining({
      commandCommentId: '44',
      kind: 'queued',
      summary: expect.stringContaining(headSha.slice(0, 7)),
    }));
    expect(store.complete).toHaveBeenCalledWith({
      commandId,
      workerId: 'worker-1',
      status: 'completed',
      replyUrl: 'https://github.com/owner/repo/pull/29#issuecomment-77',
      reviewRunId,
      patchProposalId: null,
    });
  });

  it('answers once without queueing when current write access is absent', async () => {
    const { client, handler, reader, store } = dependencies();
    client.canMaintain.mockResolvedValue(false);

    await handler.handle(commandId);

    expect(reader.get).not.toHaveBeenCalled();
    expect(store.queueReview).not.toHaveBeenCalled();
    expect(client.publishReply).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'denied',
    }));
    expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'denied',
      reviewRunId: null,
    }));
  });

  it('releases transient failures for BullMQ retry', async () => {
    const { handler, store } = dependencies();
    store.queueReview.mockRejectedValue(new Error('database unavailable'));

    await expect(handler.handle(commandId)).rejects.toThrow('will be retried');

    expect(store.release).toHaveBeenCalledWith({
      commandId,
      workerId: 'worker-1',
    });
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('publishes a bounded error and fails after the retry cap', async () => {
    const { client, handler, store } = dependencies(5);
    store.queueReview.mockRejectedValue(new Error('database unavailable'));

    await handler.handle(commandId);

    expect(client.publishReply).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'error',
    }));
    expect(store.fail).toHaveBeenCalledWith({
      commandId,
      workerId: 'worker-1',
      replyUrl: 'https://github.com/owner/repo/pull/29#issuecomment-77',
    });
  });

  it('does not acknowledge completion after losing its lease', async () => {
    const { handler, store } = dependencies();
    store.renew.mockResolvedValue(false);

    await expect(handler.handle(commandId)).rejects.toThrow('will be retried');

    expect(store.complete).not.toHaveBeenCalled();
  });

  it('prepares an approval-gated proposal and links the dashboard reply', async () => {
    const { client, handler, proposals, reader, store } = dependencies();
    store.claim.mockResolvedValue({ ...command(), command: 'propose_fix' });
    proposals.prepare.mockResolvedValue({ proposalId, reviewRunId, headSha });

    await handler.handle(commandId);

    expect(reader.get).not.toHaveBeenCalled();
    expect(store.queueReview).not.toHaveBeenCalled();
    expect(proposals.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'propose_fix' }),
      expect.any(AbortSignal),
    );
    expect(client.publishReply).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'proposal',
      summary: expect.stringContaining(`#review-${reviewRunId}`),
    }));
    expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      reviewRunId: null,
      patchProposalId: proposalId,
    }));
  });

  it('reuses a durably linked proposal after a reply interruption', async () => {
    const { handler, proposals, store } = dependencies();
    store.claim.mockResolvedValue({
      ...command(),
      command: 'propose_fix',
      patchProposalId: proposalId,
      proposalReviewRunId: reviewRunId,
      proposalHeadSha: headSha,
    });

    await handler.handle(commandId);

    expect(proposals.prepare).not.toHaveBeenCalled();
    expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({
      patchProposalId: proposalId,
    }));
  });

  it('records an ignored reply when no current finding is eligible', async () => {
    const { client, handler, store } = dependencies();
    store.claim.mockResolvedValue({ ...command(), command: 'propose_fix' });

    await handler.handle(commandId);

    expect(client.publishReply).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ignored',
    }));
    expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ignored',
      reviewRunId: null,
      patchProposalId: null,
    }));
  });
});
