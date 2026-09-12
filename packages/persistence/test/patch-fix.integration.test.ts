import { createHash, randomInt, randomUUID } from 'node:crypto';

import { createDefaultWalkzConfig } from '@walkz/contracts';
import {
  bindPatchProofToRepositoryCommand,
  digestProofCommand,
} from '@walkz/engine';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  claimPatchFixJob,
  claimGitHubCommentCommand,
  completePatchFixJob,
  createPatchFixProposalForCommentCommand,
  decidePatchFixProposal,
  loadClaimedPatchFixTarget,
  releasePatchFixJob,
} from '../src/index.js';

const databaseUrl = process.env.WALKZ_POSTGRES_TEST_URL;
const integration = databaseUrl === undefined ? it.skip : it;
const pools: Pool[] = [];

function createTestPool(): Pool {
  if (databaseUrl === undefined) {
    throw new Error('WALKZ_POSTGRES_TEST_URL is required.');
  }
  const pool = new Pool({ connectionString: databaseUrl });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe('PostgreSQL hosted patch fix jobs', () => {
  integration('queues one recoverable job for an exact approved proposal', async () => {
    const pool = createTestPool();
    const userId = randomUUID();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    const configId = randomUUID();
    const pullRequestId = randomUUID();
    const reviewRunId = randomUUID();
    const findingId = randomUUID();
    const commandId = randomUUID();
    const deliveryId = randomUUID();
    const githubUserId = String(randomInt(100_000_000, 999_999_999));
    const githubInstallationId = String(randomInt(100_000_000, 999_999_999));
    const githubRepositoryId = String(randomInt(100_000_000, 999_999_999));
    const githubPullRequestId = String(randomInt(100_000_000, 999_999_999));
    const baseSha = 'a'.repeat(40);
    const headSha = 'b'.repeat(40);
    const patchHash = 'c'.repeat(64);
    const proofImage = `node@sha256:${'f'.repeat(64)}`;
    const command = { executable: 'npm', args: ['test'], cwd: '.' };
    const config = {
      ...createDefaultWalkzConfig([{
        id: 'test', ...command, required: true,
      }]),
      commandApprovalPolicy: 'trusted_config' as const,
    };
    const configHash = createHash('sha256')
      .update(JSON.stringify(config), 'utf8')
      .digest('hex');
    const commandDigest = digestProofCommand(command);
    const proofBinding = bindPatchProofToRepositoryCommand({
      reviewRunId,
      findingFingerprint: 'e'.repeat(64),
      baseSha,
      headSha,
      commandDigest,
      containerImage: proofImage,
      config,
    });
    let proposalId: string | null = null;

    try {
      await pool.query(
        'INSERT INTO users (id, github_id, login) VALUES ($1, $2, $3)',
        [userId, githubUserId, `user-${githubUserId}`],
      );
      await pool.query(
        `INSERT INTO github_installations (id, github_id, account_login)
         VALUES ($1, $2, 'owner')`,
        [installationId, githubInstallationId],
      );
      await pool.query(
        `INSERT INTO user_installations (user_id, installation_id)
         VALUES ($1, $2)`,
        [userId, installationId],
      );
      await pool.query(
        `INSERT INTO repositories
          (id, installation_id, github_id, owner_login, repository_name)
         VALUES ($1, $2, $3, 'owner', 'repo')`,
        [repositoryId, installationId, githubRepositoryId],
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
         VALUES ($1, $2, 1, $3, $4::jsonb)`,
        [configId, repositoryId, configHash, JSON.stringify(config)],
      );
      await pool.query(
        `INSERT INTO pull_requests
          (id, repository_id, github_id, number, base_sha, head_sha)
         VALUES ($1, $2, $3, 7, $4, $5)`,
        [pullRequestId, repositoryId, githubPullRequestId, baseSha, headSha],
      );
      await pool.query(
        `INSERT INTO review_runs
          (id, repository_id, pull_request_id, config_id, config_hash,
           base_sha, head_sha, provider, model, prompt_version, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 'groq', 'auto', 'walkz-review-v1', 'awaiting_human')`,
        [
          reviewRunId,
          repositoryId,
          pullRequestId,
          configId,
          configHash,
          baseSha,
          headSha,
        ],
      );
      await pool.query(
        `INSERT INTO findings
          (id, review_run_id, fingerprint, lifecycle_status,
           evidence_level, summary, category, severity, file_path,
           start_line, end_line, claim, failure_mechanism,
           suggested_proof, advisory_confidence)
         VALUES ($1, $2, $3, 'verified', 'VERIFIED', 'Verified regression',
                 'correctness', 'high', 'src/value.ts', 3, 3,
                 'The fallback is ignored.', 'Undefined is returned.',
                 'Run npm test.', 0.99)`,
        [findingId, reviewRunId, 'e'.repeat(64)],
      );
      await pool.query(
        `INSERT INTO evidence
          (finding_id, evidence_kind, plan_digest, command_digest,
           base_outcome, head_outcome, base_exit_code, head_exit_code,
           duration_ms, sanitized_summary, artifact_hashes)
         VALUES ($1, 'counterfactual_proof', $2, $3,
                 'passed', 'failed', 0, 1, 20,
                 'Base passed; head failed.', '[]'::jsonb)`,
        [findingId, proofBinding.planDigest, commandDigest],
      );

      await pool.query(
        `INSERT INTO webhook_deliveries
          (id, delivery_id, installation_id, event_name, payload_hash)
         VALUES ($1, $2, $3, 'issue_comment', $4)`,
        [deliveryId, randomUUID(), installationId, '9'.repeat(64)],
      );
      await pool.query(
        `INSERT INTO github_comment_commands
          (id, webhook_delivery_id, repository_id, github_comment_id,
           commenter_github_id, commenter_login, pull_request_number, command)
         VALUES ($1, $2, $3, $4, $5, 'maintainer', 7, 'propose_fix')`,
        [
          commandId,
          deliveryId,
          repositoryId,
          String(randomInt(1_000_000_000, 1_999_999_999)),
          githubUserId,
        ],
      );
      await expect(claimGitHubCommentCommand(pool, {
        commandId,
        workerId: 'command-worker',
        leaseMs: 60_000,
      })).resolves.toMatchObject({ command: 'propose_fix', patchProposalId: null });

      const created = await createPatchFixProposalForCommentCommand(pool, {
        commandId,
        workerId: 'command-worker',
        proposal: {
          reviewRunId,
          findingId,
          baseSha,
          headSha,
          patchHash,
          deliveryMode: 'suggestion',
        },
        provider: 'groq',
        model: 'openai/gpt-oss-120b',
        promptVersion: 'walkz-patch-v1',
        proofPlanDigest: proofBinding.planDigest,
        proofCommandDigest: commandDigest,
      });
      proposalId = created.proposal.id;
      await expect(pool.query(
        `SELECT patch_proposal_id AS "patchProposalId"
         FROM github_comment_commands WHERE id = $1`,
        [commandId],
      )).resolves.toMatchObject({ rows: [{ patchProposalId: proposalId }] });

      const decisionInput = {
        repositoryId,
        actorUserId: userId,
        proposalId,
        expectedPatchHash: patchHash,
        expectedHeadSha: headSha,
        decision: 'approved' as const,
      };
      const approved = await decidePatchFixProposal(pool, decisionInput);
      const duplicate = await decidePatchFixProposal(pool, decisionInput);
      expect(approved).toMatchObject({
        outcome: 'applied',
        job: { status: 'queued' },
      });
      expect(duplicate).toMatchObject({
        outcome: 'unchanged',
        job: { status: 'queued' },
        outboxEventId: approved.outboxEventId,
      });

      await expect(claimPatchFixJob(pool, {
        proposalId,
        workerId: 'worker-1',
        leaseMs: 60_000,
      })).resolves.toBeNull();
      await pool.query(
        `UPDATE patch_proposals
         SET github_reference_kind = 'review_comment', github_reference = $2
         WHERE id = $1`,
        [proposalId, 'https://github.com/owner/repo/pull/7#discussion_r42'],
      );

      const claimed = await claimPatchFixJob(pool, {
        proposalId,
        workerId: 'worker-1',
        leaseMs: 60_000,
      });
      expect(claimed).toMatchObject({ status: 'reproving', attempt: 1 });
      await expect(loadClaimedPatchFixTarget(pool, {
        proposalId,
        workerId: 'worker-1',
      })).resolves.toMatchObject({
        repositoryId,
        decidedByUserId: userId,
        proof: {
          planDigest: proofBinding.planDigest,
          commandDigest,
          baseOutcome: 'passed',
          headOutcome: 'failed',
        },
        proposal: { patchHash, headSha },
        job: { status: 'reproving', attempt: 1 },
      });
      await expect(completePatchFixJob(pool, {
        proposalId,
        workerId: 'worker-1',
        outcome: 'resolved',
      })).resolves.toBeNull();
      await expect(releasePatchFixJob(pool, {
        proposalId,
        workerId: 'worker-1',
      })).resolves.toBe(true);

      const outbox = await pool.query(
        `SELECT payload FROM outbox_events
         WHERE aggregate_id = $1 AND event_type = 'patch_fix.queued'`,
        [proposalId],
      );
      expect(outbox.rows).toEqual([{ payload: { proposalId } }]);
    } finally {
      await pool.query('DELETE FROM github_comment_commands WHERE id = $1', [commandId]);
      await pool.query('DELETE FROM webhook_deliveries WHERE id = $1', [deliveryId]);
      if (proposalId !== null) {
        await pool.query(
          `DELETE FROM audit_events
           WHERE actor_user_id = $1 OR metadata->>'subjectId' = $2`,
          [userId, proposalId],
        );
        await pool.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [proposalId]);
        await pool.query('DELETE FROM patch_fix_jobs WHERE proposal_id = $1', [proposalId]);
      }
      await pool.query('DELETE FROM patch_proposals WHERE review_run_id = $1', [reviewRunId]);
      await pool.query(
        'DELETE FROM evidence WHERE finding_id IN (SELECT id FROM findings WHERE review_run_id = $1)',
        [reviewRunId],
      );
      await pool.query('DELETE FROM findings WHERE review_run_id = $1', [reviewRunId]);
      await pool.query('DELETE FROM review_runs WHERE id = $1', [reviewRunId]);
      await pool.query('DELETE FROM pull_requests WHERE id = $1', [pullRequestId]);
      await pool.query('DELETE FROM repository_configs WHERE id = $1', [configId]);
      await pool.query('DELETE FROM user_repository_access WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM user_installations WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
      await pool.query('DELETE FROM github_installations WHERE id = $1', [installationId]);
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });
});
