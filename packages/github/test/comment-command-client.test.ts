import { describe, expect, it, vi } from 'vitest';

import {
  createGitHubCommentCommandClient,
  GitHubCommandReplyConflictError,
  type OctokitRequestClient,
} from '../src/index.js';

const target = { owner: 'owner', repository: 'walkz' };
const reply = {
  ...target,
  pullRequestNumber: 28,
  commandCommentId: '9012',
  kind: 'queued' as const,
  summary: 'Walkz queued a review for this pull request.',
};
const body = `${reply.summary}\n\n<!-- walkz-command:9012:queued -->`;

function client(request: OctokitRequestClient['request']) {
  return createGitHubCommentCommandClient({ request }, 77);
}

describe('GitHub comment command client', () => {
  it.each([
    ['admin', true],
    ['write', true],
    ['read', false],
    ['none', false],
  ] as const)('maps current %s permission to maintain access', async (permission, allowed) => {
    const request = vi.fn().mockResolvedValue({ data: { permission } });

    await expect(client(request).canMaintain({ ...target, username: 'maintainer' }))
      .resolves.toBe(allowed);
    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
      { owner: 'owner', repo: 'walkz', username: 'maintainer' },
    );
  });

  it('fails closed for a user GitHub does not expose as a collaborator', async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('missing'), {
      status: 404,
    }));

    await expect(client(request).canMaintain({ ...target, username: 'outsider' }))
      .resolves.toBe(false);
  });

  it('does not turn an unavailable permission check into a denial', async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('unavailable'), {
      status: 503,
    }));

    await expect(client(request).canMaintain({ ...target, username: 'maintainer' }))
      .rejects.toThrow('unavailable');
  });

  it('reuses an identical reply created by this GitHub App', async () => {
    const request = vi.fn().mockResolvedValue({
      data: [{
        id: 444,
        body,
        html_url: 'https://github.test/reply/444',
        performed_via_github_app: { id: 77 },
      }],
    });

    await expect(client(request).publishReply(reply)).resolves.toEqual({
      commentId: '444',
      url: 'https://github.test/reply/444',
      reused: true,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects conflicting reuse by this GitHub App', async () => {
    const request = vi.fn().mockResolvedValue({
      data: [{
        id: 444,
        body: `Different text\n\n<!-- walkz-command:9012:queued -->`,
        html_url: 'https://github.test/reply/444',
        performed_via_github_app: { id: 77 },
      }],
    });

    await expect(client(request).publishReply(reply))
      .rejects.toBeInstanceOf(GitHubCommandReplyConflictError);
  });

  it('ignores a marker posted through another GitHub App', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        data: [{
          id: 333,
          body,
          html_url: 'https://github.test/reply/333',
          performed_via_github_app: { id: 88 },
        }],
      })
      .mockResolvedValueOnce({
        data: {
          id: 444,
          body,
          html_url: 'https://github.test/reply/444',
          performed_via_github_app: { id: 77 },
        },
      });

    await expect(client(request).publishReply(reply)).resolves.toEqual({
      commentId: '444',
      url: 'https://github.test/reply/444',
      reused: false,
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      {
        owner: 'owner',
        repo: 'walkz',
        issue_number: 28,
        body,
      },
    );
  });

  it('rejects a created reply attributed to another GitHub App', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: {
          id: 444,
          body,
          html_url: 'https://github.test/reply/444',
          performed_via_github_app: { id: 88 },
        },
      });

    await expect(client(request).publishReply(reply))
      .rejects.toThrow('did not attribute the command reply to this App');
  });

  it('fails closed when bounded history cannot prove the reply is absent', async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: null,
      html_url: `https://github.test/reply/${index + 1}`,
      performed_via_github_app: { id: 77 },
    }));
    const request = vi.fn().mockResolvedValue({ data: page });

    await expect(client(request).publishReply(reply))
      .rejects.toThrow('exceeded the idempotency scan limit');
    expect(request).toHaveBeenCalledTimes(10);
  });
});
