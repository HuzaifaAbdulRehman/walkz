import type { PoolClient } from 'pg';
import { z } from 'zod';

import { createGitHubCheckQueuedOutboxEvent } from './outbox.js';
import { createQueuedReviewRunInTransaction } from './review-run.js';
import { supersedeActiveReviewRuns } from './review-run-control.js';

const githubIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(
  (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
  { message: 'GitHub IDs must fit PostgreSQL BIGINT.' },
);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);

const githubReviewRunInputSchema = z.object({
  repositoryId: z.uuid(),
  configId: z.uuid(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/i),
  provider: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
  promptVersion: z.string().trim().min(1).max(128),
  installationId: githubIdSchema,
  repositoryOwner: z.string().trim().min(1).max(100),
  repositoryName: z.string().trim().min(1).max(100),
  pullRequestId: githubIdSchema,
  pullRequestNumber: z.number().int().positive(),
  baseSha: shaSchema,
  headSha: shaSchema,
}).strict().refine((review) => review.baseSha !== review.headSha, {
  message: 'Reviews require different base and head commits.',
  path: ['headSha'],
});

export interface QueuedGitHubReviewRun {
  reviewRunId: string;
  outboxEventIds: [string, string];
  supersededRunIds: string[];
}

async function upsertPullRequest(
  client: Pick<PoolClient, 'query'>,
  review: z.infer<typeof githubReviewRunInputSchema>,
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
    [
      review.repositoryId,
      review.pullRequestId,
      review.pullRequestNumber,
      review.baseSha,
      review.headSha,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Pull request upsert did not return an ID.');
  }
  return row.id;
}

export async function queueGitHubReviewRun(
  client: Pick<PoolClient, 'query'>,
  input: unknown,
): Promise<QueuedGitHubReviewRun> {
  const review = githubReviewRunInputSchema.parse(input);
  const pullRequestId = await upsertPullRequest(client, review);
  const run = await createQueuedReviewRunInTransaction(client, {
    repositoryId: review.repositoryId,
    pullRequestId,
    configId: review.configId,
    configHash: review.configHash,
    baseSha: review.baseSha,
    headSha: review.headSha,
    provider: review.provider,
    model: review.model,
    promptVersion: review.promptVersion,
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
      installationId: review.installationId,
      owner: review.repositoryOwner,
      repository: review.repositoryName,
      baseSha: review.baseSha,
      headSha: review.headSha,
    },
  });
  return {
    reviewRunId: run.reviewRunId,
    outboxEventIds: [run.outboxEventId, checkOutboxEventId],
    supersededRunIds,
  };
}
