import { describe, expect, it, vi } from 'vitest';

import { createInstallationPullRequestReaderFactory } from '../src/index.js';

const payload = {
  id: 789,
  number: 7,
  state: 'open',
  draft: false,
  base: {
    sha: 'a'.repeat(40),
    repo: { id: 456, name: 'repo', owner: { login: 'owner' } },
  },
  head: { sha: 'b'.repeat(40) },
};

describe('installation pull request reader', () => {
  it('reads exact revisions with an installation client', async () => {
    const request = vi.fn().mockResolvedValue({ data: payload });
    const getInstallationOctokit = vi.fn().mockResolvedValue({ request });
    const factory = createInstallationPullRequestReaderFactory({
      getInstallationOctokit,
    });
    const reader = await factory.forInstallation('123');

    await expect(reader.get({ owner: 'owner', repository: 'repo' }, 7))
      .resolves.toEqual({
        githubId: '789',
        number: 7,
        repositoryGitHubId: '456',
        repositoryOwner: 'owner',
        repositoryName: 'repo',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        draft: false,
      });
    expect(getInstallationOctokit).toHaveBeenCalledWith(123);
    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}',
      { owner: 'owner', repo: 'repo', pull_number: 7 },
    );
  });

  it('rejects closed pull requests and mismatched repositories', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ data: { ...payload, state: 'closed' } })
      .mockResolvedValueOnce({
        data: { ...payload, base: { ...payload.base, repo: {
          ...payload.base.repo,
          id: 999,
          name: 'other',
        } } },
      });
    const reader = await createInstallationPullRequestReaderFactory({
      getInstallationOctokit: vi.fn().mockResolvedValue({ request }),
    }).forInstallation('123');

    await expect(reader.get({ owner: 'owner', repository: 'repo' }, 7))
      .rejects.toThrow();
    await expect(reader.get({ owner: 'owner', repository: 'repo' }, 7))
      .rejects.toThrow('another repository');
  });
});
