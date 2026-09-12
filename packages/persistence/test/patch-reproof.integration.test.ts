import { randomInt, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import { recordPatchReproofResult } from '../src/index.js';

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

describe('PostgreSQL patch reproof evidence', () => {
  integration('stores one immutable result without changing the source finding', async () => {
    const pool = createTestPool();
    const userId = randomUUID();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    const configId = randomUUID();
    const pullRequestId = randomUUID();
    const runId = randomUUID();
    const findingId = randomUUID();
    const proposalId = randomUUID();
    const githubId = () => String(randomInt(100_000_000, 999_999_999));
    const baseSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const patchHash = 'c'.repeat(64);

    cleanups.push(async () => {
      await pool.query(
        `DELETE FROM audit_events
         WHERE actor_user_id = $1 OR metadata->>'subjectId' = $2`,
        [userId, proposalId],
      );
      await pool.query('DELETE FROM evidence WHERE patch_proposal_id = $1', [proposalId]);
      await pool.query('DELETE FROM patch_proposals WHERE id = $1', [proposalId]);
      await pool.query('DELETE FROM findings WHERE id = $1', [findingId]);
      await pool.query('DELETE FROM review_runs WHERE id = $1', [runId]);
      await pool.query('DELETE FROM pull_requests WHERE id = $1', [pullRequestId]);
      await pool.query('DELETE FROM repository_configs WHERE id = $1', [configId]);
      await pool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
      await pool.query('DELETE FROM github_installations WHERE id = $1', [installationId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    });

    await pool.query(
      'INSERT INTO users (id, github_id, login) VALUES ($1, $2, $3)',
      [userId, githubId(), `user-${userId}`],
    );
    await pool.query(
      `INSERT INTO github_installations (id, github_id, account_login)
       VALUES ($1, $2, 'owner')`,
      [installationId, githubId()],
    );
    await pool.query(
      `INSERT INTO repositories
        (id, installation_id, github_id, owner_login, repository_name)
       VALUES ($1, $2, $3, 'owner', 'repo')`,
      [repositoryId, installationId, githubId()],
    );
    await pool.query(
      `INSERT INTO repository_configs
        (id, repository_id, schema_version, config_hash, config)
       VALUES ($1, $2, 1, $3, '{}'::jsonb)`,
      [configId, repositoryId, 'd'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO pull_requests
        (id, repository_id, github_id, number, base_sha, head_sha)
       VALUES ($1, $2, $3, 1, $4, $5)`,
      [pullRequestId, repositoryId, githubId(), baseSha, headSha],
    );
    await pool.query(
      `INSERT INTO review_runs
        (id, repository_id, pull_request_id, config_id, config_hash,
         base_sha, head_sha, provider, model, prompt_version, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               'groq', 'model', 'v1', 'awaiting_human')`,
      [
        runId,
        repositoryId,
        pullRequestId,
        configId,
        'd'.repeat(64),
        baseSha,
        headSha,
      ],
    );
    await pool.query(
      `INSERT INTO findings
        (id, review_run_id, fingerprint, lifecycle_status,
         evidence_level, summary)
       VALUES ($1, $2, $3, 'verified', 'VERIFIED', $4)`,
      [findingId, runId, 'e'.repeat(64), 'Verified regression.'],
    );
    await pool.query(
      `INSERT INTO patch_proposals (
        id, review_run_id, finding_id, patch_hash, approval_status,
        base_sha, head_sha, delivery_mode, decided_by_user_id,
        decided_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'approved', $5, $6, 'suggestion', $7,
        now(), now()
      )`,
      [proposalId, runId, findingId, patchHash, baseSha, headSha, userId],
    );

    const result = {
      schemaVersion: 1,
      proposalId,
      reviewRunId: runId,
      findingId,
      attempt: 1,
      patchHash,
      headSha,
      outcome: 'resolved',
      proof: {
        kind: 'proof',
        planDigest: 'f'.repeat(64),
        commandDigest: '1'.repeat(64),
        outcome: 'passed',
        exitCode: 0,
        durationMs: 12,
        sanitizedSummary: 'proof passed',
        artifacts: [],
      },
      regressions: [],
      recordedAt: '2026-09-11T12:00:00.000Z',
    } as const;

    const concurrent = await Promise.all([
      recordPatchReproofResult(pool, result),
      recordPatchReproofResult(pool, result),
    ]);
    expect(concurrent.map((entry) => entry.outcome).sort()).toEqual([
      'applied',
      'unchanged',
    ]);
    await expect(recordPatchReproofResult(pool, result)).resolves.toMatchObject({
      outcome: 'unchanged',
    });
    await expect(recordPatchReproofResult(pool, {
      ...result,
      proof: { ...result.proof, sanitizedSummary: 'different result' },
    })).resolves.toMatchObject({ outcome: 'conflict' });

    const stored = await pool.query(
      `SELECT e.reproof_outcome AS "outcome",
              e.patch_hash AS "patchHash",
              e.head_sha AS "headSha",
              e.reproof_result AS "result",
              f.lifecycle_status AS "findingStatus"
       FROM evidence e
       JOIN findings f ON f.id = e.finding_id
       WHERE e.patch_proposal_id = $1`,
      [proposalId],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      outcome: 'resolved',
      patchHash,
      headSha,
      findingStatus: 'verified',
      result: { proposalId, patchHash, headSha, outcome: 'resolved' },
    });
    expect(JSON.stringify(stored.rows[0].result)).not.toContain('replacement');

    await expect(pool.query(
      `INSERT INTO evidence (
        finding_id, evidence_kind, plan_digest, command_digest,
        head_outcome, head_exit_code,
        duration_ms, sanitized_summary, artifact_hashes,
        review_run_id, patch_proposal_id, patch_hash, head_sha,
        reproof_attempt, reproof_outcome, reproof_result
      ) VALUES (
        $1, 'patch_reproof', $2, $3, 'passed', 0,
        1, 'tampered', '[]'::jsonb,
        $4, $5, $6, $7, 2, 'resolved', $8::jsonb
      )`,
      [
        findingId,
        result.proof.planDigest,
        result.proof.commandDigest,
        runId,
        proposalId,
        patchHash,
        headSha,
        JSON.stringify({ ...result, attempt: 3 }),
      ],
    )).rejects.toMatchObject({
      constraint: 'evidence_reproof_result_binding_check',
    });

    await pool.query(
      'UPDATE pull_requests SET head_sha = $2 WHERE id = $1',
      [pullRequestId, '2'.repeat(40)],
    );
    await expect(recordPatchReproofResult(pool, {
      ...result,
      attempt: 2,
      recordedAt: '2026-09-11T12:01:00.000Z',
    })).resolves.toMatchObject({ outcome: 'conflict', result: null });
  });
});
