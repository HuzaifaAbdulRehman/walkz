import { describe, expect, it, vi } from 'vitest';

import {
  createInstallationReviewCheckPublisherFactory,
  createOctokitChecksClient,
} from '../src/index.js';

const queued = {
  name: 'Walkz / review',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  status: 'queued' as const,
  conclusion: null,
  summary: 'Review queued.',
  annotations: [],
};

describe('Octokit checks adapter', () => {
  it('maps create and update calls to GitHub check-run fields', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: 42 } })
      .mockResolvedValueOnce({ data: { id: 42 } });
    const client = createOctokitChecksClient({ request });

    await expect(client.create({
      owner: 'owner',
      repo: 'repo',
      name: queued.name,
      headSha: queued.headSha,
      status: queued.status,
      conclusion: null,
      summary: queued.summary,
      annotations: [],
      externalId: 'review-run-1',
    })).resolves.toEqual({ id: 42 });
    await expect(client.update({
      owner: 'owner',
      repo: 'repo',
      checkRunId: 42,
      name: queued.name,
      status: 'completed',
      conclusion: 'success',
      summary: 'No blocking findings.',
      annotations: [],
    })).resolves.toEqual({ id: 42 });

    expect(request).toHaveBeenNthCalledWith(1, 'POST /repos/{owner}/{repo}/check-runs', {
      owner: 'owner',
      repo: 'repo',
      name: 'Walkz / review',
      head_sha: queued.headSha,
      status: 'queued',
      external_id: 'review-run-1',
      output: { title: 'Walkz / review', summary: 'Review queued.', annotations: [] },
    });
    expect(request).toHaveBeenNthCalledWith(
      2,
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}',
      expect.objectContaining({ check_run_id: 42, conclusion: 'success' }),
    );
  });

  it('finds a matching external ID on the exact head commit', async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        check_runs: [
          { id: 41, external_id: 'another-run' },
          { id: 42, external_id: 'review-run-1' },
        ],
      },
    });
    const client = createOctokitChecksClient({ request });

    await expect(client.findByExternalId({
      owner: 'owner',
      repo: 'repo',
      name: 'Walkz / review',
      headSha: queued.headSha,
      externalId: 'review-run-1',
    })).resolves.toEqual({ id: 42, external_id: 'review-run-1' });
    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      expect.objectContaining({ ref: queued.headSha, check_name: 'Walkz / review' }),
    );
  });

  it('scopes publishers to a validated installation ID', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { check_runs: [] } })
      .mockResolvedValueOnce({ data: { id: 42 } });
    const getInstallationOctokit = vi.fn().mockResolvedValue({ request });
    const factory = createInstallationReviewCheckPublisherFactory({ getInstallationOctokit });

    const publisher = await factory.forInstallation('1234');
    await publisher.publish({ owner: 'owner', repository: 'repo' }, queued, 'review-run-1');

    expect(getInstallationOctokit).toHaveBeenCalledWith(1234);
    expect(request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
      expect.objectContaining({ owner: 'owner', repo: 'repo' }),
    );
  });
});
