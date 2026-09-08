import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { createReviewRunQueuedOutboxEvent, withTransaction } from './outbox.js';

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);

export const queuedReviewRunSchema = z
  .object({
    repositoryId: z.uuid(),
    pullRequestId: z.uuid().nullable(),
    configId: z.uuid(),
    configHash: z.string().regex(/^[a-f0-9]{64}$/i),
    baseSha: shaSchema,
    headSha: shaSchema,
    provider: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(256),
    promptVersion: z.string().trim().min(1).max(128),
  })
  .strict()
  .refine((run) => run.baseSha !== run.headSha, {
    message: 'Review runs require different base and head commits.',
    path: ['headSha'],
  });

export interface CreatedQueuedReviewRun {
  reviewRunId: string;
  outboxEventId: string;
}

export async function createQueuedReviewRun(
  pool: Pick<Pool, 'connect'>,
  input: unknown,
): Promise<CreatedQueuedReviewRun> {
  const run = queuedReviewRunSchema.parse(input);
  return withTransaction(pool, async (client) => {
    const reviewRunId = await insertQueuedReviewRun(client, run);
    const outboxEventId = await createReviewRunQueuedOutboxEvent(client, {
      aggregateId: reviewRunId,
      eventType: 'review_run.queued',
      payload: { reviewRunId },
    });
    return { reviewRunId, outboxEventId };
  });
}

async function insertQueuedReviewRun(
  client: Pick<PoolClient, 'query'>,
  run: z.infer<typeof queuedReviewRunSchema>,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO review_runs (
        repository_id, pull_request_id, config_id, config_hash, base_sha,
        head_sha, provider, model, prompt_version, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued')
      RETURNING id
    `,
    [
      run.repositoryId,
      run.pullRequestId,
      run.configId,
      run.configHash,
      run.baseSha,
      run.headSha,
      run.provider,
      run.model,
      run.promptVersion,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Review run creation did not return an ID.');
  }
  return row.id;
}
