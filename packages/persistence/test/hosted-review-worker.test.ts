import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { createDefaultWalkzConfig } from '@walkz/contracts';

import {
  claimHostedReviewRun,
  listRecoverableHostedReviewRunIds,
  renewHostedReviewRunLease,
} from '../src/index.js';

const reviewRunId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const require = createRequire(import.meta.url);
const { up: addWorkerLeases } = require('../../../migrations/007_review_worker_leases.js') as {
  up: (pgm: { sql: (statement: string) => void }) => void;
};

describe('hosted review worker leases', () => {
  it('adds recoverable worker leases with a bounded migration lock', () => {
    const pgm = { sql: vi.fn() };

    addWorkerLeases(pgm);

    expect(pgm.sql.mock.calls[0]?.[0]).toContain("lock_timeout = '5s'");
    expect(pgm.sql.mock.calls[1]?.[0]).toContain('worker_lease_expires_at');
    expect(pgm.sql.mock.calls[1]?.[0]).toContain('review_runs_worker_recovery_idx');
    expect(pgm.sql.mock.calls[2]?.[0]).toContain('RESET lock_timeout');
  });

  it('claims an exact durable run and validates its immutable config', async () => {
    const config = createDefaultWalkzConfig();
    const row = {
      reviewRunId,
      repositoryId: '08d0dd85-734e-4f74-bcfc-3436ec7b4abd',
      installationId: '123',
      owner: 'owner',
      repository: 'walkz',
      pullRequestNumber: 7,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      configHash: createHash('sha256')
        .update(JSON.stringify(config), 'utf8')
        .digest('hex'),
      config,
      provider: 'groq',
      model: 'auto',
      promptVersion: 'walkz-review-v1',
      status: 'collecting_context',
    };
    const query = vi.fn().mockResolvedValue({ rows: [row] });

    await expect(claimHostedReviewRun({ query }, {
      reviewRunId,
      workerId: 'worker-1',
      leaseMs: 60_000,
    })).resolves.toEqual(row);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("rr.status = 'queued'"),
      expect.arrayContaining([reviewRunId, 'worker-1', 60_000]),
    );
    expect(query.mock.calls[0]?.[0]).toContain('worker_lease_expires_at IS NULL');
  });

  it('rejects configuration that does not match the durable hash', async () => {
    const config = createDefaultWalkzConfig();
    const query = vi.fn().mockResolvedValue({ rows: [{
      reviewRunId,
      repositoryId: '08d0dd85-734e-4f74-bcfc-3436ec7b4abd',
      installationId: '123',
      owner: 'owner',
      repository: 'walkz',
      pullRequestNumber: 7,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      configHash: 'c'.repeat(64),
      config,
      provider: 'groq',
      model: 'auto',
      promptVersion: 'walkz-review-v1',
      status: 'collecting_context',
    }] });

    await expect(claimHostedReviewRun({ query }, {
      reviewRunId,
      workerId: 'worker-1',
      leaseMs: 60_000,
    })).rejects.toThrow('does not match its immutable hash');
  });

  it('rejects a provider snapshot that disagrees with its configuration', async () => {
    const config = createDefaultWalkzConfig();
    const query = vi.fn().mockResolvedValue({ rows: [{
      reviewRunId,
      repositoryId: '08d0dd85-734e-4f74-bcfc-3436ec7b4abd',
      installationId: '123',
      owner: 'owner',
      repository: 'walkz',
      pullRequestNumber: 7,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      configHash: createHash('sha256')
        .update(JSON.stringify(config), 'utf8')
        .digest('hex'),
      config,
      provider: 'groq',
      model: 'different-model',
      promptVersion: 'walkz-review-v1',
      status: 'collecting_context',
    }] });

    await expect(claimHostedReviewRun({ query }, {
      reviewRunId,
      workerId: 'worker-1',
      leaseMs: 60_000,
    })).rejects.toThrow('provider does not match');
  });

  it('skips a run held by another active worker', async () => {
    await expect(claimHostedReviewRun(
      { query: vi.fn().mockResolvedValue({ rows: [] }) },
      { reviewRunId, workerId: 'worker-1', leaseMs: 60_000 },
    )).resolves.toBeNull();
  });

  it('renews a lease only for its current owner', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: reviewRunId }] });

    await expect(renewHostedReviewRunLease({ query }, {
      reviewRunId,
      workerId: 'worker-1',
      leaseMs: 60_000,
    })).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('worker_lease_owner = $2'),
      expect.arrayContaining([reviewRunId, 'worker-1', 60_000]),
    );
  });

  it('lists queued and expired runs for Redis recovery', async () => {
    const secondId = '57ee26ad-408d-4db3-bb78-93bc5b2242ad';
    const query = vi.fn().mockResolvedValue({
      rows: [{ reviewRunId }, { reviewRunId: secondId }],
    });

    await expect(listRecoverableHostedReviewRunIds({ query }, 100)).resolves.toEqual([
      reviewRunId,
      secondId,
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'queued'"),
      expect.arrayContaining([100]),
    );
    expect(query.mock.calls[0]?.[0]).toContain('worker_lease_expires_at <= now()');
  });
});
