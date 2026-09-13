import { randomInt, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { recordModelInvocation } from '../src/index.js';

const databaseUrl = process.env.WALKZ_POSTGRES_TEST_URL;
const integration = databaseUrl === undefined ? it.skip : it;
const pools: Pool[] = [];
const cleanups: Array<() => Promise<void>> = [];
const hash = (value: string): string => value.repeat(64);

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

async function createReviewRun(pool: Pool): Promise<string> {
  const installationId = randomUUID();
  const repositoryId = randomUUID();
  const configId = randomUUID();
  const runId = randomUUID();
  const githubInstallationId = String(randomInt(100_000_000, 999_999_999));
  const githubRepositoryId = String(randomInt(100_000_000, 999_999_999));

  cleanups.push(async () => {
    await pool.query('DELETE FROM model_invocations WHERE review_run_id = $1', [runId]);
    await pool.query('DELETE FROM review_runs WHERE id = $1', [runId]);
    await pool.query('DELETE FROM repository_configs WHERE id = $1', [configId]);
    await pool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
    await pool.query('DELETE FROM github_installations WHERE id = $1', [installationId]);
  });
  await pool.query(
    `INSERT INTO github_installations (id, github_id, account_login)
     VALUES ($1, $2, 'owner')`,
    [installationId, githubInstallationId],
  );
  await pool.query(
    `INSERT INTO repositories
      (id, installation_id, github_id, owner_login, repository_name)
     VALUES ($1, $2, $3, 'owner', 'repo')`,
    [repositoryId, installationId, githubRepositoryId],
  );
  await pool.query(
    `INSERT INTO repository_configs
      (id, repository_id, schema_version, config_hash, config)
     VALUES ($1, $2, 1, $3, '{}'::jsonb)`,
    [configId, repositoryId, hash('e')],
  );
  await pool.query(
    `INSERT INTO review_runs
      (id, repository_id, config_id, config_hash, base_sha, head_sha,
       provider, model, prompt_version, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'groq', 'model', 'v1', 'reviewing')`,
    [runId, repositoryId, configId, hash('e'), 'a'.repeat(40), 'b'.repeat(40)],
  );
  return runId;
}

function success(reviewRunId: string, overrides: Record<string, unknown> = {}) {
  return {
    reviewRunId,
    invocationKey: hash('1'),
    stage: 'review',
    status: 'succeeded',
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    promptVersion: 'walkz-review-v1',
    promptHash: hash('2'),
    responseHash: hash('3'),
    usage: {
      promptTokens: 100,
      completionTokens: 25,
      totalTokens: 125,
      latencyMs: 40,
      rateLimit: {
        retryAfterMs: null,
        remainingRequests: null,
        remainingTokens: null,
        resetRequests: null,
        resetTokens: null,
      },
    },
    requestId: 'request-1',
    errorCode: null,
    durationMs: 40,
    ...overrides,
  };
}

describe('PostgreSQL model invocation telemetry', () => {
  integration('deduplicates retries and rejects successful response drift', async () => {
    const pool = createTestPool();
    const reviewRunId = await createReviewRun(pool);
    const first = await recordModelInvocation(pool, success(reviewRunId));
    const replay = await recordModelInvocation(pool, success(reviewRunId));

    expect(replay).toEqual({ ...first, attemptCount: 2 });
    await expect(recordModelInvocation(pool, success(reviewRunId, {
      responseHash: hash('4'),
    }))).rejects.toThrow('conflicts with its immutable request or response');
    const stored = await pool.query(
      `SELECT status, response_hash AS "responseHash",
              attempt_count AS "attemptCount", usage
       FROM model_invocations
       WHERE review_run_id = $1 AND invocation_key = $2`,
      [reviewRunId, hash('1')],
    );
    expect(stored.rows).toEqual([expect.objectContaining({
      status: 'succeeded',
      responseHash: hash('3'),
      attemptCount: 2,
    })]);
  });

  integration('promotes a failed logical invocation after a successful retry', async () => {
    const pool = createTestPool();
    const reviewRunId = await createReviewRun(pool);
    const failed = success(reviewRunId, {
      status: 'failed',
      responseHash: null,
      usage: null,
      requestId: null,
      errorCode: 'request_failed',
    });

    await expect(recordModelInvocation(pool, failed)).resolves.toMatchObject({
      status: 'failed',
      attemptCount: 1,
    });
    await expect(recordModelInvocation(pool, success(reviewRunId))).resolves.toMatchObject({
      status: 'succeeded',
      attemptCount: 2,
    });
  });
});
