import { randomInt, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { recordFindingFeedback } from '../src/index.js';

const databaseUrl = process.env.WALKZ_POSTGRES_TEST_URL;
const integration = databaseUrl === undefined ? it.skip : it;
const pools: Pool[] = [];
const cleanups: Array<() => Promise<void>> = [];

function pool(): Pool {
  if (databaseUrl === undefined) throw new Error('WALKZ_POSTGRES_TEST_URL is required.');
  const value = new Pool({ connectionString: databaseUrl });
  pools.push(value);
  return value;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await Promise.all(pools.splice(0).map((value) => value.end()));
});

async function fixture(database: Pool) {
  const userId = randomUUID();
  const installationId = randomUUID();
  const repositoryId = randomUUID();
  const configId = randomUUID();
  const reviewRunId = randomUUID();
  const findingId = randomUUID();
  cleanups.push(async () => {
    await database.query('DELETE FROM finding_feedback WHERE review_run_id = $1', [reviewRunId]);
    await database.query('DELETE FROM findings WHERE review_run_id = $1', [reviewRunId]);
    await database.query('DELETE FROM review_runs WHERE id = $1', [reviewRunId]);
    await database.query('DELETE FROM repository_configs WHERE id = $1', [configId]);
    await database.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
    await database.query('DELETE FROM github_installations WHERE id = $1', [installationId]);
    await database.query('DELETE FROM users WHERE id = $1', [userId]);
  });
  await database.query(
    `INSERT INTO users (id, github_id, login) VALUES ($1, $2, 'maintainer')`,
    [userId, String(randomInt(100_000_000, 999_999_999))],
  );
  await database.query(
    `INSERT INTO github_installations (id, github_id, account_login)
     VALUES ($1, $2, 'owner')`,
    [installationId, String(randomInt(100_000_000, 999_999_999))],
  );
  await database.query(
    `INSERT INTO repositories
       (id, installation_id, github_id, owner_login, repository_name)
     VALUES ($1, $2, $3, 'owner', 'repo')`,
    [repositoryId, installationId, String(randomInt(100_000_000, 999_999_999))],
  );
  await database.query(
    `INSERT INTO repository_configs
       (id, repository_id, schema_version, config_hash, config)
     VALUES ($1, $2, 1, $3, '{}'::jsonb)`,
    [configId, repositoryId, 'e'.repeat(64)],
  );
  await database.query(
    `INSERT INTO review_runs
       (id, repository_id, config_id, config_hash, base_sha, head_sha,
        provider, model, prompt_version, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'groq', 'model', 'v1', 'completed')`,
    [
      reviewRunId,
      repositoryId,
      configId,
      'e'.repeat(64),
      'a'.repeat(40),
      'b'.repeat(40),
    ],
  );
  await database.query(
    `INSERT INTO findings
       (id, review_run_id, fingerprint, lifecycle_status, evidence_level, summary)
     VALUES ($1, $2, $3, 'verified', 'VERIFIED', 'Bound finding')`,
    [findingId, reviewRunId, 'f'.repeat(64)],
  );
  return { actorUserId: userId, repositoryId, reviewRunId, findingId };
}

describe('PostgreSQL finding feedback', () => {
  integration('is append-only, idempotent, and repository scoped', async () => {
    const database = pool();
    const target = await fixture(database);
    const requestId = randomUUID();
    const input = {
      requestId,
      ...target,
      assessment: 'false_positive',
      reason: 'incorrect_claim',
    };

    await expect(recordFindingFeedback(database, input)).resolves.toMatchObject({
      outcome: 'created',
      feedback: { assessment: 'false_positive', reason: 'incorrect_claim' },
    });
    await expect(recordFindingFeedback(database, input)).resolves.toMatchObject({
      outcome: 'duplicate',
    });
    await expect(recordFindingFeedback(database, {
      ...input,
      assessment: 'correct',
      reason: null,
    })).resolves.toEqual({ outcome: 'conflict', feedback: null });
    await expect(recordFindingFeedback(database, {
      ...input,
      requestId: randomUUID(),
      repositoryId: randomUUID(),
    })).resolves.toEqual({ outcome: 'not_found', feedback: null });
    const rows = await database.query(
      `SELECT assessment, reason FROM finding_feedback WHERE request_id = $1`,
      [requestId],
    );
    expect(rows.rows).toEqual([{
      assessment: 'false_positive',
      reason: 'incorrect_claim',
    }]);
  });
});
