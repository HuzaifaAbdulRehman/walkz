import { parseWalkzConfig } from '@walkz/contracts';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { createGitHubCheckQueuedOutboxEvent, withTransaction } from './outbox.js';
import { createQueuedReviewRunInTransaction } from './review-run.js';
import { supersedeActiveReviewRuns } from './review-run-control.js';
import { insertWebhookDelivery } from './webhook-delivery.js';

const githubIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(
  (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
  { message: 'GitHub IDs must fit PostgreSQL BIGINT.' },
);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);

const webhookReviewSchema = z
  .object({
    trigger: z.enum(['ready_for_review', 'synchronize']),
    installationId: githubIdSchema,
    repositoryId: githubIdSchema,
    repositoryOwner: z.string().trim().min(1).max(100),
    repositoryName: z.string().trim().min(1).max(100),
    pullRequestId: githubIdSchema,
    pullRequestNumber: z.number().int().positive(),
    baseSha: shaSchema,
    headSha: shaSchema,
  })
  .strict()
  .refine((review) => review.baseSha !== review.headSha, {
    message: 'Webhook reviews require different base and head commits.',
    path: ['headSha'],
  });

const webhookIntakeSchema = z
  .object({
    deliveryId: z.string().trim().min(1).max(255),
    eventName: z.string().trim().min(1).max(128),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/i),
    promptVersion: z.string().trim().min(1).max(128),
    review: webhookReviewSchema.nullable(),
  })
  .strict()
  .refine((input) => input.review === null || input.eventName === 'pull_request', {
    message: 'Pull request review data requires a pull_request event.',
    path: ['eventName'],
  });

interface RepositoryReviewContext {
  installationId: string;
  repositoryId: string;
  configId: string;
  configHash: string;
  config: unknown;
}

export type GitHubWebhookIntakeResult =
  | { status: 'duplicate' }
  | { status: 'ignored'; reason: 'event_not_reviewable' | 'repository_not_configured' | 'trigger_disabled' }
  | {
      status: 'queued';
      reviewRunId: string;
      outboxEventIds: [string, string];
      supersededRunIds: string[];
    };

function triggerEnabled(
  policy: 'manual' | 'ready_for_review' | 'every_push',
  trigger: 'ready_for_review' | 'synchronize',
): boolean {
  if (policy === 'manual') return false;
  if (policy === 'ready_for_review') return trigger === 'ready_for_review';
  return true;
}

async function loadRepositoryContext(
  client: Pick<PoolClient, 'query'>,
  installationId: string,
  repositoryId: string,
): Promise<RepositoryReviewContext | null> {
  const result = await client.query<RepositoryReviewContext>(
    `
      SELECT gi.id AS "installationId",
             r.id AS "repositoryId",
             rc.id AS "configId",
             rc.config_hash AS "configHash",
             rc.config
      FROM github_installations gi
      JOIN repositories r ON r.installation_id = gi.id
      JOIN LATERAL (
        SELECT id, config_hash, config
        FROM repository_configs
        WHERE repository_id = r.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) rc ON true
      WHERE gi.github_id = $1::bigint
        AND r.github_id = $2::bigint
    `,
    [installationId, repositoryId],
  );
  return result.rows[0] ?? null;
}

async function attachDeliveryAndRefreshRepository(
  client: Pick<PoolClient, 'query'>,
  deliveryId: string,
  context: RepositoryReviewContext,
  owner: string,
  repository: string,
): Promise<void> {
  await client.query(
    'UPDATE webhook_deliveries SET installation_id = $2 WHERE id = $1',
    [deliveryId, context.installationId],
  );
  await client.query(
    'UPDATE repositories SET owner_login = $2, repository_name = $3 WHERE id = $1',
    [context.repositoryId, owner, repository],
  );
}

async function upsertPullRequest(
  client: Pick<PoolClient, 'query'>,
  input: z.infer<typeof webhookReviewSchema>,
  repositoryId: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO pull_requests (
        repository_id, github_id, number, base_sha, head_sha
      )
      VALUES ($1, $2::bigint, $3, $4, $5)
      ON CONFLICT (repository_id, number) DO UPDATE
      SET github_id = EXCLUDED.github_id,
          base_sha = EXCLUDED.base_sha,
          head_sha = EXCLUDED.head_sha
      RETURNING id
    `,
    [repositoryId, input.pullRequestId, input.pullRequestNumber, input.baseSha, input.headSha],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Pull request upsert did not return an ID.');
  return row.id;
}

export async function acceptGitHubWebhook(
  pool: Pick<Pool, 'connect'>,
  input: unknown,
): Promise<GitHubWebhookIntakeResult> {
  const request = webhookIntakeSchema.parse(input);
  return withTransaction(pool, async (client) => {
    const storedDeliveryId = await insertWebhookDelivery(client, request);
    if (storedDeliveryId === null) return { status: 'duplicate' };
    if (request.review === null) {
      return { status: 'ignored', reason: 'event_not_reviewable' };
    }

    const context = await loadRepositoryContext(
      client,
      request.review.installationId,
      request.review.repositoryId,
    );
    if (context === null) {
      return { status: 'ignored', reason: 'repository_not_configured' };
    }
    await attachDeliveryAndRefreshRepository(
      client,
      storedDeliveryId,
      context,
      request.review.repositoryOwner,
      request.review.repositoryName,
    );

    const config = parseWalkzConfig(context.config);
    if (!triggerEnabled(config.triggerPolicy, request.review.trigger)) {
      return { status: 'ignored', reason: 'trigger_disabled' };
    }

    const pullRequestId = await upsertPullRequest(client, request.review, context.repositoryId);
    const run = await createQueuedReviewRunInTransaction(client, {
      repositoryId: context.repositoryId,
      pullRequestId,
      configId: context.configId,
      configHash: context.configHash,
      baseSha: request.review.baseSha,
      headSha: request.review.headSha,
      provider: config.provider.name,
      model: config.provider.model,
      promptVersion: request.promptVersion,
    });
    const supersededRunIds = await supersedeActiveReviewRuns(client, {
      pullRequestId,
      replacementRunId: run.reviewRunId,
    });
    const checkOutboxEventId = await createGitHubCheckQueuedOutboxEvent(client, {
      aggregateId: run.reviewRunId,
      eventType: 'github_check.queued',
      payload: {
        reviewRunId: run.reviewRunId,
        installationId: request.review.installationId,
        owner: request.review.repositoryOwner,
        repository: request.review.repositoryName,
        baseSha: request.review.baseSha,
        headSha: request.review.headSha,
      },
    });
    return {
      status: 'queued',
      reviewRunId: run.reviewRunId,
      outboxEventIds: [run.outboxEventId, checkOutboxEventId],
      supersededRunIds,
    };
  });
}
