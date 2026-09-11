import { createDefaultWalkzConfig } from '@walkz/contracts';
import { describe, expect, it, vi } from 'vitest';

import { acceptGitHubWebhook } from '../src/index.js';

const ids = {
  delivery: '3d963b52-8203-4ba6-bcac-15bf132371f0',
  installation: '08d0dd85-734e-4f74-bcfc-3436ec7b4abd',
  repository: '09e7392c-03bb-4b34-b099-0803fb0d9023',
  config: 'fc9b22da-25aa-4654-a254-bf4636f0c902',
  pullRequest: '2de86cd9-2c66-4d62-82a2-42c965cc1613',
  reviewRun: 'efaa8b7e-6e48-445a-83d5-d2cc730ef816',
  reviewEvent: '4b79fc1b-1c89-4431-9d76-02ca23296ccd',
  checkEvent: 'b9d56748-0990-4d4a-a9ba-5860a50490c1',
  oldRun: '376618a1-a8ed-4ee7-8688-b7bb39f16fcb',
};

const request = {
  deliveryId: 'delivery-1',
  eventName: 'pull_request',
  payloadHash: 'c'.repeat(64),
  promptVersion: 'walkz-review-v1',
  review: {
    trigger: 'ready_for_review' as const,
    installationId: '1234',
    repositoryId: '5678',
    repositoryOwner: 'HuzaifaAbdulRehman',
    repositoryName: 'walkz',
    pullRequestId: '9012',
    pullRequestNumber: 7,
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
  },
};

function context(triggerPolicy: 'manual' | 'ready_for_review' | 'every_push') {
  return {
    installationId: ids.installation,
    repositoryId: ids.repository,
    configId: ids.config,
    configHash: 'd'.repeat(64),
    config: { ...createDefaultWalkzConfig(), triggerPolicy },
  };
}

function poolWith(query: ReturnType<typeof vi.fn>) {
  return {
    connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
  };
}

describe('GitHub webhook review intake', () => {
  it('commits delivery, exact-SHA run, supersession, and outbox events together', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: ids.delivery }] })
      .mockResolvedValueOnce({ rows: [context('ready_for_review')] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: ids.pullRequest }] })
      .mockResolvedValueOnce({ rows: [{ id: ids.reviewRun }] })
      .mockResolvedValueOnce({ rows: [{ id: ids.reviewEvent }] })
      .mockResolvedValueOnce({ rows: [{ id: ids.oldRun }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: ids.checkEvent }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(acceptGitHubWebhook(poolWith(query), request)).resolves.toEqual({
      status: 'queued',
      reviewRunId: ids.reviewRun,
      outboxEventIds: [ids.reviewEvent, ids.checkEvent],
      supersededRunIds: [ids.oldRun],
    });
    expect(query.mock.calls.map(([sql]) => String(sql).trim())).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO webhook_deliveries'),
      expect.stringContaining('JOIN LATERAL'),
      expect.stringContaining('UPDATE webhook_deliveries'),
      expect.stringContaining('UPDATE repositories'),
      expect.stringContaining('INSERT INTO pull_requests'),
      expect.stringContaining('INSERT INTO review_runs'),
      expect.stringContaining('INSERT INTO outbox_events'),
      expect.stringContaining("SET status = 'superseded'"),
      expect.stringContaining('WITH stale_proposals AS'),
      expect.stringContaining('INSERT INTO outbox_events'),
      'COMMIT',
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO review_runs'),
      expect.arrayContaining([request.review.baseSha, request.review.headSha]),
    );
  });

  it('deduplicates before reading repository state', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(acceptGitHubWebhook(poolWith(query), request)).resolves.toEqual({
      status: 'duplicate',
    });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('records disabled triggers without creating a review run', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: ids.delivery }] })
      .mockResolvedValueOnce({ rows: [context('manual')] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(acceptGitHubWebhook(poolWith(query), request)).resolves.toEqual({
      status: 'ignored',
      reason: 'trigger_disabled',
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO review_runs'))).toBe(false);
  });

  it('rolls back the delivery when stored configuration is invalid', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: ids.delivery }] })
      .mockResolvedValueOnce({ rows: [{ ...context('manual'), config: { schemaVersion: 1 } }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(acceptGitHubWebhook(poolWith(query), request)).rejects.toThrow();
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
