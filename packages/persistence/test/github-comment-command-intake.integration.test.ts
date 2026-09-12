import { randomInt, randomUUID } from 'node:crypto';

import { createDefaultWalkzConfig } from '@walkz/contracts';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  acceptGitHubWebhook,
  claimReviewCommentCommand,
  completeGitHubCommentCommand,
  renewGitHubCommentCommandLease,
} from '../src/index.js';

const databaseUrl = process.env.WALKZ_POSTGRES_TEST_URL;
const integration = databaseUrl === undefined ? it.skip : it;
const pools: Pool[] = [];

function createTestPool(): Pool {
  if (databaseUrl === undefined) throw new Error('WALKZ_POSTGRES_TEST_URL is required.');
  const pool = new Pool({ connectionString: databaseUrl });
  pools.push(pool);
  return pool;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe('PostgreSQL GitHub comment command intake', () => {
  integration('deduplicates one parsed command and stores identifiers only', async () => {
    const pool = createTestPool();
    const installationId = randomUUID();
    const repositoryId = randomUUID();
    const configId = randomUUID();
    const deliveryId = randomUUID();
    const installationGitHubId = String(randomInt(100_000_000, 999_999_999));
    const repositoryGitHubId = String(randomInt(1_000_000_000, 1_999_999_999));
    const commentGitHubId = String(randomInt(2_000_000_000, 2_999_999_999));
    const commenterGitHubId = String(randomInt(3_000_000_000, 3_999_999_999));

    try {
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
        [
          configId,
          repositoryId,
          'd'.repeat(64),
          JSON.stringify(createDefaultWalkzConfig()),
        ],
      );
      const request = {
        deliveryId,
        eventName: 'issue_comment',
        payloadHash: 'c'.repeat(64),
        promptVersion: 'walkz-review-v1',
        review: null,
        command: {
          command: 'review' as const,
          installationId: installationGitHubId,
          repositoryId: repositoryGitHubId,
          repositoryOwner: 'owner',
          repositoryName: 'repo',
          pullRequestNumber: 28,
          commentId: commentGitHubId,
          commenterId: commenterGitHubId,
          commenterLogin: 'maintainer',
        },
      };

      const first = await acceptGitHubWebhook(pool, request);
      await expect(acceptGitHubWebhook(pool, request)).resolves.toEqual({
        status: 'duplicate',
      });
      expect(first.status).toBe('command_queued');
      if (first.status !== 'command_queued') throw new Error('Command was not queued.');

      const stored = await pool.query(
        `SELECT repository_id AS "repositoryId",
                github_comment_id::text AS "commentId",
                commenter_github_id::text AS "commenterId",
                commenter_login AS "commenterLogin",
                pull_request_number AS "pullRequestNumber",
                command, status
         FROM github_comment_commands WHERE id = $1`,
        [first.commandId],
      );
      expect(stored.rows).toEqual([{
        repositoryId,
        commentId: commentGitHubId,
        commenterId: commenterGitHubId,
        commenterLogin: 'maintainer',
        pullRequestNumber: 28,
        command: 'review',
        status: 'queued',
      }]);
      const outbox = await pool.query(
        `SELECT payload FROM outbox_events
         WHERE aggregate_id = $1 AND event_type = 'github_comment_command.queued'`,
        [first.commandId],
      );
      expect(outbox.rows).toEqual([{ payload: { commandId: first.commandId } }]);

      const lease = {
        commandId: first.commandId,
        workerId: 'integration-worker',
        leaseMs: 60_000,
      };
      await expect(claimReviewCommentCommand(pool, lease)).resolves.toMatchObject({
        commandId: first.commandId,
        repositoryId,
        installationId: installationGitHubId,
        repositoryGitHubId,
        command: 'review',
        attempt: 1,
      });
      await expect(renewGitHubCommentCommandLease(pool, lease)).resolves.toBe(true);
      await expect(completeGitHubCommentCommand(pool, {
        commandId: first.commandId,
        workerId: lease.workerId,
        status: 'denied',
        replyUrl: 'https://github.com/owner/repo/pull/28#issuecomment-1',
        reviewRunId: null,
      })).resolves.toBe(true);
      const completed = await pool.query(
        `SELECT status, attempt, lease_owner AS "leaseOwner",
                lease_expires_at AS "leaseExpiresAt", reply_url AS "replyUrl"
         FROM github_comment_commands WHERE id = $1`,
        [first.commandId],
      );
      expect(completed.rows).toEqual([{
        status: 'denied',
        attempt: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        replyUrl: 'https://github.com/owner/repo/pull/28#issuecomment-1',
      }]);
      await expect(pool.query(
        'UPDATE github_comment_commands SET reply_url = $2 WHERE id = $1',
        [first.commandId, 'https://github.com/owner/repo/pull/28#issuecomment-2'],
      )).rejects.toThrow('Terminal comment commands cannot be changed.');
    } finally {
      await pool.query(
        `DELETE FROM outbox_events
         WHERE aggregate_id IN (
           SELECT id FROM github_comment_commands WHERE repository_id = $1
         )`,
        [repositoryId],
      );
      await pool.query(
        'DELETE FROM github_comment_commands WHERE repository_id = $1',
        [repositoryId],
      );
      await pool.query(
        'DELETE FROM webhook_deliveries WHERE installation_id = $1',
        [installationId],
      );
      await pool.query('DELETE FROM repository_configs WHERE repository_id = $1', [repositoryId]);
      await pool.query('DELETE FROM repositories WHERE id = $1', [repositoryId]);
      await pool.query('DELETE FROM github_installations WHERE id = $1', [installationId]);
    }
  });
});
