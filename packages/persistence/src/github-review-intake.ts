import { parseWalkzConfig } from '@walkz/contracts';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { queueGitHubReviewRun } from './github-review-run.js';
import {
  createGitHubCommentCommandQueuedOutboxEvent,
  withTransaction,
} from './outbox.js';
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

const webhookCommandSchema = z.object({
  command: z.enum(['review', 'propose_fix']),
  installationId: githubIdSchema,
  repositoryId: githubIdSchema,
  repositoryOwner: z.string().trim().min(1).max(100),
  repositoryName: z.string().trim().min(1).max(100),
  pullRequestNumber: z.number().int().positive(),
  commentId: githubIdSchema,
  commenterId: githubIdSchema,
  commenterLogin: z.string().trim().min(1).max(100),
}).strict();

const webhookIntakeSchema = z
  .object({
    deliveryId: z.string().trim().min(1).max(255),
    eventName: z.string().trim().min(1).max(128),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/i),
    promptVersion: z.string().trim().min(1).max(128),
    review: webhookReviewSchema.nullable(),
    command: webhookCommandSchema.nullable().default(null),
  })
  .strict()
  .refine((input) => input.review === null || input.eventName === 'pull_request', {
    message: 'Pull request review data requires a pull_request event.',
    path: ['eventName'],
  })
  .refine((input) => input.command === null || input.eventName === 'issue_comment', {
    message: 'Comment command data requires an issue_comment event.',
    path: ['eventName'],
  })
  .refine((input) => input.review === null || input.command === null, {
    message: 'A webhook delivery cannot contain review and command work.',
    path: ['command'],
  });

export type GitHubWebhookIntakeInput = z.infer<typeof webhookIntakeSchema>;

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
      status: 'command_queued';
      commandId: string;
      outboxEventId: string;
    }
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

export async function acceptGitHubWebhook(
  pool: Pick<Pool, 'connect'>,
  input: unknown,
): Promise<GitHubWebhookIntakeResult> {
  const request = webhookIntakeSchema.parse(input);
  return withTransaction(pool, async (client) => {
    const storedDeliveryId = await insertWebhookDelivery(client, request);
    if (storedDeliveryId === null) return { status: 'duplicate' };
    const target = request.review ?? request.command;
    if (target === null) {
      return { status: 'ignored', reason: 'event_not_reviewable' };
    }

    const context = await loadRepositoryContext(
      client,
      target.installationId,
      target.repositoryId,
    );
    if (context === null) {
      return { status: 'ignored', reason: 'repository_not_configured' };
    }
    await attachDeliveryAndRefreshRepository(
      client,
      storedDeliveryId,
      context,
      target.repositoryOwner,
      target.repositoryName,
    );

    if (request.command !== null) {
      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO github_comment_commands (
            webhook_delivery_id, repository_id, github_comment_id,
            commenter_github_id, commenter_login, pull_request_number, command
          )
          VALUES ($1, $2, $3::bigint, $4::bigint, $5, $6, $7)
          RETURNING id
        `,
        [
          storedDeliveryId,
          context.repositoryId,
          request.command.commentId,
          request.command.commenterId,
          request.command.commenterLogin,
          request.command.pullRequestNumber,
          request.command.command,
        ],
      );
      const commandId = inserted.rows[0]?.id;
      if (commandId === undefined) {
        throw new Error('GitHub comment command insert did not return an ID.');
      }
      const outboxEventId = await createGitHubCommentCommandQueuedOutboxEvent(client, {
        aggregateId: commandId,
        eventType: 'github_comment_command.queued',
        payload: { commandId },
      });
      return { status: 'command_queued', commandId, outboxEventId };
    }
    if (request.review === null) {
      throw new Error('Webhook intake lost its validated review target.');
    }

    const config = parseWalkzConfig(context.config);
    if (!triggerEnabled(config.triggerPolicy, request.review.trigger)) {
      return { status: 'ignored', reason: 'trigger_disabled' };
    }

    const run = await queueGitHubReviewRun(client, {
      repositoryId: context.repositoryId,
      configId: context.configId,
      configHash: context.configHash,
      provider: config.provider.name,
      model: config.provider.model,
      promptVersion: request.promptVersion,
      installationId: request.review.installationId,
      repositoryOwner: request.review.repositoryOwner,
      repositoryName: request.review.repositoryName,
      pullRequestId: request.review.pullRequestId,
      pullRequestNumber: request.review.pullRequestNumber,
      baseSha: request.review.baseSha,
      headSha: request.review.headSha,
    });
    return {
      status: 'queued',
      reviewRunId: run.reviewRunId,
      outboxEventIds: run.outboxEventIds,
      supersededRunIds: run.supersededRunIds,
    };
  });
}
