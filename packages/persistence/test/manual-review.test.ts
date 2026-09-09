import { createDefaultWalkzConfig } from '@walkz/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  getManualReviewRepository,
  queueManualReview,
} from '../src/index.js';

const repositoryId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const configId = '08d0dd85-734e-4f74-bcfc-3436ec7b4abd';
const runId = 'efaa8b7e-6e48-445a-83d5-d2cc730ef816';
const reviewEventId = '4b79fc1b-1c89-4431-9d76-02ca23296ccd';
const checkEventId = 'edab20a3-473e-498d-9f01-c93907ba7d25';
const pullRequestId = 'bb779847-c6ef-4e39-814c-601707f868ce';
const input = {
  requestId: '513f194f-ae06-4689-bdab-d1299e31f614',
  repositoryId,
  installationId: '123',
  githubId: '456',
  owner: 'owner',
  repository: 'repo',
  pullRequestId: '789',
  pullRequestNumber: 7,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  promptVersion: 'walkz-review-v1',
};

describe('manual review persistence', () => {
  it('loads only the selected repository target', async () => {
    const row = {
      repositoryId,
      installationId: '123',
      githubId: '456',
      owner: 'owner',
      repository: 'repo',
    };
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    await expect(getManualReviewRepository({ query }, repositoryId))
      .resolves.toEqual(row);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE r.id = $1'),
      [repositoryId],
    );
    expect(query.mock.calls[0]?.[0]).toContain('r.id AS "repositoryId"');
    expect(query.mock.calls[0]?.[0]).toContain('gi.github_id::text AS "installationId"');
  });

  it('queues exact GitHub state and supersedes stale work atomically', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        configId,
        configHash: 'd'.repeat(64),
        config: createDefaultWalkzConfig(),
      }] })
      .mockResolvedValueOnce({ rows: [{ request_id: input.requestId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: pullRequestId }] })
      .mockResolvedValueOnce({ rows: [{ id: runId }] })
      .mockResolvedValueOnce({ rows: [{ id: reviewEventId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: checkEventId }] })
      .mockResolvedValueOnce({ rows: [{ request_id: input.requestId }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(queueManualReview(pool, input)).resolves.toEqual({
      reviewRunId: runId,
      created: true,
    });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FOR UPDATE OF r'),
      expect.stringContaining('INSERT INTO manual_review_requests'),
      expect.stringContaining('UPDATE repositories'),
      expect.stringContaining('INSERT INTO pull_requests'),
      expect.stringContaining('INSERT INTO review_runs'),
      expect.stringContaining('INSERT INTO outbox_events'),
      expect.stringContaining('UPDATE review_runs'),
      expect.stringContaining('INSERT INTO outbox_events'),
      expect.stringContaining('UPDATE manual_review_requests'),
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledOnce();
    expect(query.mock.calls[1]?.[0]).toContain('rc.id AS "configId"');
    expect(query.mock.calls[1]?.[0]).toContain('rc.config_hash AS "configHash"');
  });

  it('returns the original run for a repeated request key', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        configId,
        configHash: 'd'.repeat(64),
        config: createDefaultWalkzConfig(),
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        repositoryId,
        pullRequestNumber: 7,
        baseSha: input.baseSha,
        headSha: input.headSha,
        reviewRunId: runId,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };

    await expect(queueManualReview(pool, input)).resolves.toEqual({
      reviewRunId: runId,
      created: false,
    });
    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[3]?.[0]).toContain('base_sha AS "baseSha"');
    expect(query.mock.calls[3]?.[0]).toContain('review_run_id AS "reviewRunId"');
  });

  it('rolls back when the repository identity changed', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    };

    await expect(queueManualReview(pool, input)).rejects.toThrow(
      'context changed before queueing',
    );
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('FOR UPDATE OF r'),
      'ROLLBACK',
    ]);
  });
});
