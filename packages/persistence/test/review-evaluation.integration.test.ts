import { randomInt, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { exportReviewEvaluationSnapshot } from '../src/index.js';

const databaseUrl = process.env.WALKZ_POSTGRES_TEST_URL;
const integration = databaseUrl === undefined ? it.skip : it;
const pools: Pool[] = [];
const cleanups: Array<() => Promise<void>> = [];

function pool(): Pool {
  if (databaseUrl === undefined) {
    throw new Error('WALKZ_POSTGRES_TEST_URL is required.');
  }
  const value = new Pool({ connectionString: databaseUrl });
  pools.push(value);
  return value;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await Promise.all(pools.splice(0).map((value) => value.end()));
});

describe('PostgreSQL review evaluation export', () => {
  integration('binds access and exports latest feedback with proof outcomes', async () => {
    const database = pool();
    const actorUserId = randomUUID();
    const unauthorizedUserId = randomUUID();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    const configId = randomUUID();
    const reviewRunId = randomUUID();
    const findingId = randomUUID();
    const githubInstallationId = String(randomInt(100_000_000, 999_999_999));
    const githubRepositoryId = String(randomInt(100_000_000, 999_999_999));

    cleanups.push(async () => {
      await database.query('DELETE FROM finding_feedback WHERE review_run_id = $1', [reviewRunId]);
      await database.query('DELETE FROM evidence WHERE finding_id = $1', [findingId]);
      await database.query('DELETE FROM model_invocations WHERE review_run_id = $1', [reviewRunId]);
      await database.query('DELETE FROM findings WHERE review_run_id = $1', [reviewRunId]);
      await database.query('DELETE FROM review_runs WHERE id = $1', [reviewRunId]);
      await database.query('DELETE FROM repository_configs WHERE id = $1', [configId]);
      await database.query('DELETE FROM user_repository_access WHERE user_id = $1', [actorUserId]);
      await database.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
      await database.query('DELETE FROM user_installations WHERE user_id = $1', [actorUserId]);
      await database.query('DELETE FROM github_installations WHERE id = $1', [installationId]);
      await database.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[actorUserId, unauthorizedUserId]]);
    });

    await database.query(
      `INSERT INTO users (id, github_id, login)
       VALUES ($1, $2, 'maintainer'), ($3, $4, 'outsider')`,
      [
        actorUserId,
        String(randomInt(100_000_000, 999_999_999)),
        unauthorizedUserId,
        String(randomInt(100_000_000, 999_999_999)),
      ],
    );
    await database.query(
      `INSERT INTO github_installations (id, github_id, account_login)
       VALUES ($1, $2, 'owner')`,
      [installationId, githubInstallationId],
    );
    await database.query(
      `INSERT INTO user_installations (user_id, installation_id)
       VALUES ($1, $2)`,
      [actorUserId, installationId],
    );
    await database.query(
      `INSERT INTO repositories
         (id, installation_id, github_id, owner_login, repository_name)
       VALUES ($1, $2, $3, 'owner', 'repo')`,
      [repositoryId, installationId, githubRepositoryId],
    );
    await database.query(
      `INSERT INTO user_repository_access
         (user_id, installation_id, github_repository_id)
       VALUES ($1, $2, $3)`,
      [actorUserId, installationId, githubRepositoryId],
    );
    await database.query(
      `INSERT INTO repository_configs
         (id, repository_id, schema_version, config_hash, config)
       VALUES ($1, $2, 1, $3, '{}'::jsonb)`,
      [configId, repositoryId, 'a'.repeat(64)],
    );
    await database.query(
      `INSERT INTO review_runs
         (id, repository_id, config_id, config_hash, base_sha, head_sha,
          provider, model, prompt_version, status, created_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'groq', 'requested-model',
         'requested-prompt', 'completed', $7, $7)`,
      [
        reviewRunId,
        repositoryId,
        configId,
        'a'.repeat(64),
        'b'.repeat(40),
        'c'.repeat(40),
        new Date('2026-09-15T00:00:00.000Z'),
      ],
    );
    await database.query(
      `INSERT INTO model_invocations
         (review_run_id, invocation_key, stage, status, provider, model,
          prompt_version, prompt_hash, response_hash, usage, duration_ms)
       VALUES ($1, $2, 'review', 'succeeded', 'groq', 'actual-model',
         'actual-prompt', $3, $4, $5::jsonb, 52)`,
      [
        reviewRunId,
        'd'.repeat(64),
        'e'.repeat(64),
        'f'.repeat(64),
        JSON.stringify({
          promptTokens: 70,
          completionTokens: 30,
          totalTokens: 100,
          latencyMs: 51,
          rateLimit: {
            retryAfterMs: null,
            remainingRequests: null,
            remainingTokens: null,
            resetRequests: null,
            resetTokens: null,
          },
        }),
      ],
    );
    await database.query(
      `INSERT INTO findings
         (id, review_run_id, fingerprint, lifecycle_status,
          evidence_level, summary)
       VALUES ($1, $2, $3, 'fixed', 'VERIFIED', 'Bound finding')`,
      [findingId, reviewRunId, '1'.repeat(64)],
    );
    await database.query(
      `INSERT INTO evidence
         (finding_id, evidence_kind, command_digest, base_exit_code,
          head_exit_code, duration_ms, sanitized_summary, artifact_hashes,
          plan_digest, base_outcome, head_outcome)
       VALUES ($1, 'counterfactual_proof', $2, 0, 1, 20, 'Bound proof',
         '[]'::jsonb, $3, 'passed', 'failed')`,
      [findingId, '2'.repeat(64), '3'.repeat(64)],
    );
    await database.query(
      `INSERT INTO finding_feedback
         (request_id, review_run_id, finding_id, actor_user_id,
          assessment, reason, created_at)
       VALUES
         ($1, $2, $3, $4, 'correct', NULL, $5),
         ($6, $2, $3, $4, 'false_positive', 'not_actionable', $7)`,
      [
        randomUUID(),
        reviewRunId,
        findingId,
        actorUserId,
        new Date('2026-09-16T00:00:00.000Z'),
        randomUUID(),
        new Date('2026-09-17T00:00:00.000Z'),
      ],
    );

    const selection = {
      repositoryId,
      cohortId: 'authorized-export',
      createdAfter: new Date('2026-09-01T00:00:00.000Z'),
      createdBefore: new Date('2026-10-01T00:00:00.000Z'),
    };
    await expect(exportReviewEvaluationSnapshot(database, {
      ...selection,
      actorUserId: unauthorizedUserId,
    })).resolves.toBeNull();
    await expect(exportReviewEvaluationSnapshot(database, {
      ...selection,
      actorUserId,
    })).resolves.toMatchObject({
      runs: [{
        provider: 'groq',
        model: 'actual-model',
        promptVersion: 'actual-prompt',
        usage: { totalTokens: 100, latencyMs: 52 },
        findings: [{
          findingId,
          proofOutcome: 'verified',
          feedback: 'false_positive',
        }],
      }],
    });
  });
});
