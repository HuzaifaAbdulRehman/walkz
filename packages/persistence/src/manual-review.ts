import { parseWalkzConfig } from '@walkz/contracts';
import type { Pool } from 'pg';
import { z } from 'zod';

import { queueGitHubReviewRun } from './github-review-run.js';
import { withTransaction } from './outbox.js';

const githubIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(
  (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
  { message: 'GitHub IDs must fit PostgreSQL BIGINT.' },
);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);

const repositorySchema = z.object({
  repositoryId: z.uuid(),
  installationId: githubIdSchema,
  githubId: githubIdSchema,
  owner: z.string().trim().min(1).max(100),
  repository: z.string().trim().min(1).max(100),
}).strict();

export type ManualReviewRepository = z.infer<typeof repositorySchema>;

const manualReviewInputSchema = repositorySchema.extend({
  requestId: z.uuid(),
  pullRequestId: githubIdSchema,
  pullRequestNumber: z.number().int().positive(),
  baseSha: shaSchema,
  headSha: shaSchema,
  promptVersion: z.string().trim().min(1).max(128),
}).strict().refine((review) => review.baseSha !== review.headSha, {
  message: 'Manual reviews require different base and head commits.',
  path: ['headSha'],
});

export type ManualReviewInput = z.infer<typeof manualReviewInputSchema>;

const reviewContextSchema = z.object({
  configId: z.uuid(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/i),
  config: z.unknown(),
}).strict();

const storedRequestSchema = z.object({
  repositoryId: z.uuid(),
  pullRequestNumber: z.number().int().positive(),
  baseSha: shaSchema,
  headSha: shaSchema,
  reviewRunId: z.uuid(),
}).strict();

export interface ManualReviewQueueResult {
  reviewRunId: string;
  created: boolean;
}

export async function getManualReviewRepository(
  pool: Pick<Pool, 'query'>,
  repositoryIdInput: unknown,
): Promise<ManualReviewRepository | null> {
  const repositoryId = z.uuid().parse(repositoryIdInput);
  const result = await pool.query(
    `
      SELECT r.id AS repositoryId,
             gi.github_id::text AS installationId,
             r.github_id::text AS githubId,
             r.owner_login AS owner,
             r.repository_name AS repository
      FROM repositories r
      JOIN github_installations gi ON gi.id = r.installation_id
      WHERE r.id = $1
    `,
    [repositoryId],
  );
  const row = result.rows[0];
  return row === undefined ? null : repositorySchema.parse(row);
}

async function claimManualReviewRequest(
  client: Parameters<typeof queueGitHubReviewRun>[0],
  review: z.infer<typeof manualReviewInputSchema>,
): Promise<string | null> {
  const inserted = await client.query(
    `
      INSERT INTO manual_review_requests (
        request_id, repository_id, pull_request_number, base_sha, head_sha
      )
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (request_id) DO NOTHING
      RETURNING request_id
    `,
    [
      review.requestId,
      review.repositoryId,
      review.pullRequestNumber,
      review.baseSha,
      review.headSha,
    ],
  );
  if (inserted.rows.length === 1) return null;
  const existing = await client.query(
    `
      SELECT repository_id AS repositoryId,
             pull_request_number AS pullRequestNumber,
             base_sha AS baseSha,
             head_sha AS headSha,
             review_run_id AS reviewRunId
      FROM manual_review_requests
      WHERE request_id = $1
    `,
    [review.requestId],
  );
  const stored = storedRequestSchema.parse(existing.rows[0]);
  if (
    stored.repositoryId !== review.repositoryId ||
    stored.pullRequestNumber !== review.pullRequestNumber ||
    stored.baseSha !== review.baseSha ||
    stored.headSha !== review.headSha
  ) {
    throw new Error('Idempotency key was already used for another manual review.');
  }
  return stored.reviewRunId;
}

export async function queueManualReview(
  pool: Pick<Pool, 'connect'>,
  input: unknown,
): Promise<ManualReviewQueueResult> {
  const review = manualReviewInputSchema.parse(input);
  return withTransaction(pool, async (client) => {
    const contextResult = await client.query(
      `
        SELECT rc.id AS configId,
               rc.config_hash AS configHash,
               rc.config
        FROM repositories r
        JOIN github_installations gi ON gi.id = r.installation_id
        JOIN LATERAL (
          SELECT id, config_hash, config
          FROM repository_configs
          WHERE repository_id = r.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) rc ON true
        WHERE r.id = $1
          AND gi.github_id = $2::bigint
          AND r.github_id = $3::bigint
        FOR UPDATE OF r
      `,
      [review.repositoryId, review.installationId, review.githubId],
    );
    const contextRow = contextResult.rows[0];
    if (contextRow === undefined) {
      throw new Error('Manual review repository context changed before queueing.');
    }
    const context = reviewContextSchema.parse(contextRow);
    const existingRunId = await claimManualReviewRequest(client, review);
    if (existingRunId !== null) {
      return { reviewRunId: existingRunId, created: false };
    }
    const config = parseWalkzConfig(context.config);
    await client.query(
      'UPDATE repositories SET owner_login = $2, repository_name = $3 WHERE id = $1',
      [review.repositoryId, review.owner, review.repository],
    );
    const queued = await queueGitHubReviewRun(client, {
      repositoryId: review.repositoryId,
      configId: context.configId,
      configHash: context.configHash,
      provider: config.provider.name,
      model: config.provider.model,
      promptVersion: review.promptVersion,
      installationId: review.installationId,
      repositoryOwner: review.owner,
      repositoryName: review.repository,
      pullRequestId: review.pullRequestId,
      pullRequestNumber: review.pullRequestNumber,
      baseSha: review.baseSha,
      headSha: review.headSha,
    });
    const linked = await client.query(
      `
        UPDATE manual_review_requests
        SET review_run_id = $2
        WHERE request_id = $1 AND review_run_id IS NULL
        RETURNING request_id
      `,
      [review.requestId, queued.reviewRunId],
    );
    if (linked.rows.length !== 1) {
      throw new Error('Manual review request could not be linked to its run.');
    }
    return { reviewRunId: queued.reviewRunId, created: true };
  });
}
