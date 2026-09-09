import { randomInt, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { completeHostedReviewRun } from '../src/index.js';

const databaseUrl = process.env.WALKZ_POSTGRES_TEST_URL;
const integration = databaseUrl === undefined ? it.skip : it;
const pools: Pool[] = [];
const cleanups: Array<() => Promise<void>> = [];

function createTestPool(): Pool {
  if (databaseUrl === undefined) {
    throw new Error('WALKZ_POSTGRES_TEST_URL is required.');
  }
  const pool = new Pool({ connectionString: databaseUrl });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe('PostgreSQL hosted review completion', () => {
  integration('stores one final result and one durable check event', async () => {
    const pool = createTestPool();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    const configId = randomUUID();
    const runId = randomUUID();
    const githubId = String(randomInt(100_000_000, 999_999_999));
    const baseSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);

    cleanups.push(async () => {
      await pool.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [runId]);
      await pool.query('DELETE FROM review_runs WHERE id = $1', [runId]);
      await pool.query('DELETE FROM repository_configs WHERE id = $1', [configId]);
      await pool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
      await pool.query('DELETE FROM github_installations WHERE id = $1', [installationId]);
    });

    await pool.query(
      'INSERT INTO github_installations (id, github_id, account_login) VALUES ($1, $2, $3)',
      [installationId, githubId, 'owner'],
    );
    await pool.query(
      `INSERT INTO repositories
        (id, installation_id, github_id, owner_login, repository_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [repositoryId, installationId, githubId, 'owner', 'repo'],
    );
    await pool.query(
      `INSERT INTO repository_configs
        (id, repository_id, schema_version, config_hash, config)
       VALUES ($1, $2, 1, $3, '{}'::jsonb)`,
      [configId, repositoryId, 'd'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO review_runs
        (id, repository_id, config_id, config_hash, base_sha, head_sha,
         provider, model, prompt_version, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'groq', 'model', 'v1', 'proving')`,
      [runId, repositoryId, configId, 'd'.repeat(64), baseSha, headSha],
    );

    const input = {
      reviewRunId: runId,
      baseSha,
      headSha,
      verdict: 'SHIP' as const,
      summary: 'No blocking evidence.',
      findings: [],
    };

    const first = await completeHostedReviewRun(pool, input);
    const second = await completeHostedReviewRun(pool, input);
    expect(first.created).toBe(true);
    expect(second).toEqual({ ...first, created: false });

    const runs = await pool.query(
      `SELECT status, verdict, result_summary AS resultSummary
       FROM review_runs WHERE id = $1`,
      [runId],
    );
    expect(runs.rows).toEqual([{
      status: 'completed',
      verdict: 'SHIP',
      resultSummary: 'No blocking evidence.',
    }]);
    const events = await pool.query(
      `SELECT event_type AS eventType, payload
       FROM outbox_events
       WHERE aggregate_id = $1 AND event_type = 'github_check.completed'`,
      [runId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      eventType: 'github_check.completed',
      payload: { reviewRunId: runId, baseSha, headSha, verdict: 'SHIP' },
    });
  });
});
