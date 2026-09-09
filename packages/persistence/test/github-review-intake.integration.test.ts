import { randomInt, randomUUID } from 'node:crypto';

import { createDefaultWalkzConfig } from '@walkz/contracts';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { acceptGitHubWebhook } from '../src/index.js';

const databaseUrl = process.env.WALKZ_POSTGRES_TEST_URL;
const integration = databaseUrl === undefined ? it.skip : it;
const pools: Pool[] = [];
const cleanups: Array<() => Promise<void>> = [];

function createTestPool(): Pool {
  if (databaseUrl === undefined) throw new Error('WALKZ_POSTGRES_TEST_URL is required.');
  const pool = new Pool({ connectionString: databaseUrl });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe('PostgreSQL GitHub webhook intake', () => {
  integration('deduplicates delivery and supersedes an older exact-SHA run', async () => {
    const pool = createTestPool();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    const configId = randomUUID();
    const installationGitHubId = String(randomInt(100_000_000, 999_999_999));
    const repositoryGitHubId = String(randomInt(1_000_000_000, 1_999_999_999));
    const pullRequestGitHubId = String(randomInt(2_000_000_000, 2_999_999_999));
    const deliveryId = randomUUID();
    const config = { ...createDefaultWalkzConfig(), triggerPolicy: 'every_push' as const };

    cleanups.push(async () => {
      await pool.query(
        `DELETE FROM outbox_events
         WHERE aggregate_id IN (SELECT id FROM review_runs WHERE repository_id = $1)`,
        [repositoryId],
      );
      await pool.query('DELETE FROM review_runs WHERE repository_id = $1', [repositoryId]);
      await pool.query('DELETE FROM pull_requests WHERE repository_id = $1', [repositoryId]);
      await pool.query('DELETE FROM webhook_deliveries WHERE installation_id = $1', [installationId]);
      await pool.query('DELETE FROM repository_configs WHERE repository_id = $1', [repositoryId]);
      await pool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
      await pool.query('DELETE FROM github_installations WHERE id = $1', [installationId]);
    });

    await pool.query(
      'INSERT INTO github_installations (id, github_id, account_login) VALUES ($1, $2, $3)',
      [installationId, installationGitHubId, 'owner'],
    );
    await pool.query(
      `INSERT INTO repositories
        (id, installation_id, github_id, owner_login, repository_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [repositoryId, installationId, repositoryGitHubId, 'owner', 'repo'],
    );
    await pool.query(
      `INSERT INTO repository_configs
        (id, repository_id, schema_version, config_hash, config)
       VALUES ($1, $2, 1, $3, $4::jsonb)`,
      [configId, repositoryId, 'd'.repeat(64), JSON.stringify(config)],
    );

    const request = {
      deliveryId,
      eventName: 'pull_request',
      payloadHash: 'c'.repeat(64),
      promptVersion: 'walkz-review-v1',
      review: {
        trigger: 'ready_for_review' as const,
        installationId: installationGitHubId,
        repositoryId: repositoryGitHubId,
        repositoryOwner: 'owner',
        repositoryName: 'repo',
        pullRequestId: pullRequestGitHubId,
        pullRequestNumber: 7,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
      },
    };

    const first = await acceptGitHubWebhook(pool, request);
    await expect(acceptGitHubWebhook(pool, request)).resolves.toEqual({ status: 'duplicate' });
    const second = await acceptGitHubWebhook(pool, {
      ...request,
      deliveryId: randomUUID(),
      payloadHash: 'e'.repeat(64),
      review: { ...request.review, trigger: 'synchronize', headSha: 'f'.repeat(40) },
    });

    expect(first.status).toBe('queued');
    expect(second).toMatchObject({
      status: 'queued',
      supersededRunIds: first.status === 'queued' ? [first.reviewRunId] : [],
    });
    const runs = await pool.query<{ headSha: string; status: string }>(
      `SELECT head_sha AS "headSha", status
       FROM review_runs WHERE repository_id = $1 ORDER BY created_at`,
      [repositoryId],
    );
    expect(runs.rows).toEqual([
      { headSha: 'b'.repeat(40), status: 'superseded' },
      { headSha: 'f'.repeat(40), status: 'queued' },
    ]);
    const events = await pool.query<{ eventType: string }>(
      `SELECT event_type AS "eventType" FROM outbox_events
       WHERE aggregate_id IN (SELECT id FROM review_runs WHERE repository_id = $1)`,
      [repositoryId],
    );
    expect(events.rows.map((event) => event.eventType).sort()).toEqual([
      'github_check.queued',
      'github_check.queued',
      'review_run.queued',
      'review_run.queued',
    ]);

  });
});
