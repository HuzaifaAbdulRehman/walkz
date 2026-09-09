import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createManualReviewApi,
  createManualReviewStarter,
} from '../src/index.js';

const repositoryId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const requestId = '513f194f-ae06-4689-bdab-d1299e31f614';
const apps: Array<ReturnType<typeof createManualReviewApi>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('manual review API', () => {
  it('accepts an authorized manual review request', async () => {
    const start = vi.fn().mockResolvedValue({ reviewRunId: 'run-id' });
    const app = createManualReviewApi({
      authenticator: {
        authenticate: vi.fn().mockResolvedValue({ repositoryId }),
      },
      reviews: { start },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repositoryId}/pull-requests/7/reviews`,
      headers: { 'idempotency-key': requestId },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ reviewRunId: 'run-id' });
    expect(start).toHaveBeenCalledWith({
      requestId,
      repositoryId,
      pullRequestNumber: 7,
    });
  });

  it('rejects another repository before starting work', async () => {
    const start = vi.fn();
    const app = createManualReviewApi({
      authenticator: {
        authenticate: vi.fn().mockResolvedValue({
          repositoryId: '08d0dd85-734e-4f74-bcfc-3436ec7b4abd',
        }),
      },
      reviews: { start },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repositoryId}/pull-requests/7/reviews`,
      headers: { 'idempotency-key': requestId },
    });
    expect(response.statusCode).toBe(403);
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects a missing idempotency key before starting work', async () => {
    const start = vi.fn();
    const app = createManualReviewApi({
      authenticator: {
        authenticate: vi.fn().mockResolvedValue({ repositoryId }),
      },
      reviews: { start },
    });
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repositoryId}/pull-requests/7/reviews`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_idempotency_key' });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('manual review service', () => {
  it('queues only the current pull request returned by GitHub', async () => {
    const getPullRequest = vi.fn().mockResolvedValue({
      githubId: '789',
      number: 7,
      repositoryGitHubId: '456',
      repositoryOwner: 'Owner',
      repositoryName: 'Repo',
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      draft: false,
    });
    const enqueue = vi.fn().mockResolvedValue({ reviewRunId: 'run-id' });
    const starter = createManualReviewStarter({
      repositories: { get: vi.fn().mockResolvedValue({
        repositoryId,
        installationId: '123',
        githubId: '456',
        owner: 'owner',
        repository: 'repo',
      }) },
      pullRequests: {
        forInstallation: vi.fn().mockResolvedValue({ get: getPullRequest }),
      },
      queue: { enqueue },
      promptVersion: 'walkz-review-v1',
    });

    await expect(starter.start({ requestId, repositoryId, pullRequestNumber: 7 }))
      .resolves.toEqual({ reviewRunId: 'run-id' });
    expect(getPullRequest).toHaveBeenCalledWith(
      { owner: 'owner', repository: 'repo' },
      7,
    );
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      requestId,
      repositoryId,
      installationId: '123',
      githubId: '456',
      pullRequestId: '789',
      pullRequestNumber: 7,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      promptVersion: 'walkz-review-v1',
    }));
  });

  it('rejects a GitHub response for another repository', async () => {
    const enqueue = vi.fn();
    const starter = createManualReviewStarter({
      repositories: { get: vi.fn().mockResolvedValue({
        repositoryId,
        installationId: '123',
        githubId: '456',
        owner: 'owner',
        repository: 'repo',
      }) },
      pullRequests: {
        forInstallation: vi.fn().mockResolvedValue({ get: vi.fn().mockResolvedValue({
          githubId: '789',
          number: 7,
          repositoryGitHubId: '999',
          repositoryOwner: 'owner',
          repositoryName: 'repo',
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
          draft: false,
        }) }),
      },
      queue: { enqueue },
      promptVersion: 'walkz-review-v1',
    });

    await expect(starter.start({ requestId, repositoryId, pullRequestNumber: 7 }))
      .rejects.toThrow('does not match');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
