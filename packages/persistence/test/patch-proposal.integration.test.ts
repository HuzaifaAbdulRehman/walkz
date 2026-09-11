import { randomInt, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createPatchProposal,
  decidePatchProposal,
  preparePatchSuggestionPublication,
  recordPatchSuggestionPublication,
  releasePatchSuggestionPublication,
  supersedeActiveReviewRuns,
} from '../src/index.js';

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

describe('PostgreSQL patch proposal decisions', () => {
  integration('keeps approval and staleness bound to the reviewed head', async () => {
    const pool = createTestPool();
    const userId = randomUUID();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    const configId = randomUUID();
    const pullRequestId = randomUUID();
    const runId = randomUUID();
    const replacementRunId = randomUUID();
    const findingId = randomUUID();
    const githubUserId = String(randomInt(100_000_000, 999_999_999));
    const githubInstallationId = String(randomInt(100_000_000, 999_999_999));
    const githubRepositoryId = String(randomInt(100_000_000, 999_999_999));
    const githubPullRequestId = String(randomInt(100_000_000, 999_999_999));
    const baseSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const replacementHeadSha = 'd'.repeat(40);
    const patchHash = 'c'.repeat(64);
    let proposalId: string | null = null;

    cleanups.push(async () => {
      if (proposalId !== null) {
        await pool.query(
          `DELETE FROM audit_events
           WHERE actor_user_id = $1 OR metadata->>'subjectId' = $2`,
          [userId, proposalId],
        );
      }
      await pool.query('DELETE FROM patch_proposals WHERE review_run_id = $1', [runId]);
      await pool.query('DELETE FROM findings WHERE review_run_id = $1', [runId]);
      await pool.query('DELETE FROM review_runs WHERE id = ANY($1::uuid[])', [
        [runId, replacementRunId],
      ]);
      await pool.query('DELETE FROM pull_requests WHERE id = $1', [pullRequestId]);
      await pool.query('DELETE FROM repository_configs WHERE id = $1', [configId]);
      await pool.query('DELETE FROM user_repository_access WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM user_installations WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
      await pool.query('DELETE FROM github_installations WHERE id = $1', [installationId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    });

    await pool.query(
      'INSERT INTO users (id, github_id, login) VALUES ($1, $2, $3)',
      [userId, githubUserId, `user-${githubUserId}`],
    );
    await pool.query(
      `INSERT INTO github_installations (id, github_id, account_login)
       VALUES ($1, $2, $3)`,
      [installationId, githubInstallationId, 'owner'],
    );
    await pool.query(
      `INSERT INTO user_installations (user_id, installation_id)
       VALUES ($1, $2)`,
      [userId, installationId],
    );
    await pool.query(
      `INSERT INTO repositories
        (id, installation_id, github_id, owner_login, repository_name)
       VALUES ($1, $2, $3, $4, $5)`,
      [repositoryId, installationId, githubRepositoryId, 'owner', 'repo'],
    );
    await pool.query(
      `INSERT INTO user_repository_access
        (user_id, installation_id, github_repository_id)
       VALUES ($1, $2, $3)`,
      [userId, installationId, githubRepositoryId],
    );
    await pool.query(
      `INSERT INTO repository_configs
        (id, repository_id, schema_version, config_hash, config)
       VALUES ($1, $2, 1, $3, '{}'::jsonb)`,
      [configId, repositoryId, 'e'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO pull_requests
        (id, repository_id, github_id, number, base_sha, head_sha)
       VALUES ($1, $2, $3, 1, $4, $5)`,
      [pullRequestId, repositoryId, githubPullRequestId, baseSha, headSha],
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
        'e'.repeat(64),
        baseSha,
        headSha,
      ],
    );
    await pool.query(
      `INSERT INTO findings
        (id, review_run_id, fingerprint, lifecycle_status,
         evidence_level, summary)
       VALUES ($1, $2, $3, 'verified', 'VERIFIED', $4)`,
      [findingId, runId, 'f'.repeat(64), 'Verified regression.'],
    );

    const created = await createPatchProposal(pool, {
      reviewRunId: runId,
      findingId,
      baseSha,
      headSha,
      patchHash,
      deliveryMode: 'suggestion',
    });
    proposalId = created.proposal.id;
    expect(created).toMatchObject({
      created: true,
      proposal: {
        patchHash,
        headSha,
        approvalStatus: 'pending',
        staleAt: null,
      },
    });

    const approved = await decidePatchProposal(pool, {
      repositoryId,
      actorUserId: userId,
      proposalId,
      expectedPatchHash: patchHash,
      expectedHeadSha: headSha,
      decision: 'approved',
    });
    expect(approved).toMatchObject({
      outcome: 'applied',
      proposal: {
        approvalStatus: 'approved',
        decidedByUserId: userId,
        staleAt: null,
      },
    });

    const firstLease = randomUUID();
    const secondLease = randomUUID();
    const publicationInput = {
      repositoryId,
      actorUserId: userId,
      proposalId,
      expectedPatchHash: patchHash,
      expectedHeadSha: headSha,
    };
    await expect(preparePatchSuggestionPublication(pool, {
      ...publicationInput,
      publicationLeaseOwner: firstLease,
      publicationLeaseMs: 120_000,
    })).resolves.toMatchObject({ outcome: 'ready' });
    await expect(preparePatchSuggestionPublication(pool, {
      ...publicationInput,
      publicationLeaseOwner: secondLease,
      publicationLeaseMs: 120_000,
    })).resolves.toMatchObject({ outcome: 'busy' });
    await expect(releasePatchSuggestionPublication(pool, {
      proposalId,
      publicationLeaseOwner: firstLease,
    })).resolves.toBe(true);
    await expect(preparePatchSuggestionPublication(pool, {
      ...publicationInput,
      publicationLeaseOwner: secondLease,
      publicationLeaseMs: 120_000,
    })).resolves.toMatchObject({ outcome: 'ready' });
    const githubReferenceValue =
      'https://github.com/owner/repo/pull/1#discussion_r123';
    await expect(recordPatchSuggestionPublication(pool, {
      ...publicationInput,
      publicationLeaseOwner: secondLease,
      githubReferenceValue,
    })).resolves.toMatchObject({
      outcome: 'applied',
      target: {
        proposal: {
          githubReference: {
            kind: 'review_comment',
            value: githubReferenceValue,
          },
        },
      },
    });
    await expect(preparePatchSuggestionPublication(pool, {
      ...publicationInput,
      publicationLeaseOwner: randomUUID(),
      publicationLeaseMs: 120_000,
    })).resolves.toMatchObject({ outcome: 'published' });

    await pool.query(
      'UPDATE pull_requests SET head_sha = $2 WHERE id = $1',
      [pullRequestId, replacementHeadSha],
    );
    await pool.query(
      `INSERT INTO review_runs
        (id, repository_id, pull_request_id, config_id, config_hash,
         base_sha, head_sha, provider, model, prompt_version, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               'groq', 'model', 'v1', 'queued')`,
      [
        replacementRunId,
        repositoryId,
        pullRequestId,
        configId,
        'e'.repeat(64),
        headSha,
        replacementHeadSha,
      ],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(supersedeActiveReviewRuns(client, {
        pullRequestId,
        replacementRunId,
      })).resolves.toEqual([runId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const stored = await pool.query(
      `SELECT approval_status AS "approvalStatus",
              decided_by_user_id AS "decidedByUserId",
              stale_at AS "staleAt"
       FROM patch_proposals WHERE id = $1`,
      [proposalId],
    );
    expect(stored.rows).toEqual([{
      approvalStatus: 'approved',
      decidedByUserId: userId,
      staleAt: expect.any(Date),
    }]);
    const audits = await pool.query(
      `SELECT event_type AS "eventType"
       FROM audit_events
       WHERE metadata->>'subjectId' = $1
       ORDER BY created_at ASC`,
      [proposalId],
    );
    expect(audits.rows.map((row) => row.eventType)).toEqual([
      'patch_proposal.created',
      'patch_proposal.approved',
      'patch_proposal.suggestion_published',
      'patch_proposal.stale',
    ]);
    const patchColumns = await pool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'patch_proposals'`,
    );
    expect(patchColumns.rows.map((row) => row.column_name)).not.toContain(
      'patch_text',
    );
    expect(patchColumns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'publication_lease_owner',
        'publication_lease_expires_at',
      ]),
    );
  });
});
