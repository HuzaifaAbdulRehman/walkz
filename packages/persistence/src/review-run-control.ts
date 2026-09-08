import type { PoolClient } from 'pg';
import { z } from 'zod';

const reviewRunIdSchema = z.uuid();

const activeReviewRunStatuses = [
  'queued',
  'collecting_context',
  'deterministic_checks',
  'reviewing',
  'challenging',
  'proving',
  'awaiting_human',
  'fixing',
  'reproving',
] as const;

export async function cancelReviewRun(
  client: Pick<PoolClient, 'query'>,
  input: unknown,
): Promise<boolean> {
  const runId = reviewRunIdSchema.parse(input);
  const result = await client.query(
    `
      UPDATE review_runs
      SET status = 'cancelled', completed_at = now()
      WHERE id = $1 AND status = ANY($2::text[])
      RETURNING id
    `,
    [runId, activeReviewRunStatuses],
  );
  return result.rows.length === 1;
}

export async function supersedeActiveReviewRuns(
  client: Pick<PoolClient, 'query'>,
  input: unknown,
): Promise<string[]> {
  const request = z
    .object({
      pullRequestId: z.uuid(),
      replacementRunId: z.uuid(),
    })
    .strict()
    .parse(input);
  const result = await client.query<{ id: string }>(
    `
      UPDATE review_runs
      SET status = 'superseded',
          superseded_by = $2,
          completed_at = now()
      WHERE pull_request_id = $1
        AND id <> $2
        AND status = ANY($3::text[])
      RETURNING id
    `,
    [
      request.pullRequestId,
      request.replacementRunId,
      activeReviewRunStatuses,
    ],
  );
  return result.rows.map((row) => row.id);
}
