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

async function markPatchProposalsStale(
  client: Pick<PoolClient, 'query'>,
  reviewRunIds: string[],
  reason: 'cancelled' | 'superseded',
): Promise<void> {
  if (reviewRunIds.length === 0) return;
  const summary = reason === 'superseded'
    ? 'A newer pull request head made a patch proposal stale.'
    : 'Cancelling the review run made a patch proposal stale.';
  await client.query(
    `
      WITH stale_proposals AS (
        UPDATE patch_proposals pp
        SET stale_at = now(), updated_at = now()
        WHERE pp.review_run_id = ANY($1::uuid[])
          AND pp.stale_at IS NULL
        RETURNING pp.id
      )
      INSERT INTO audit_events (
        actor_user_id, event_type, summary, metadata
      )
      SELECT NULL,
             'patch_proposal.stale',
             $2,
             jsonb_build_object(
               'operation', $3::text,
               'outcome', 'completed',
               'subjectId', stale_proposals.id
             )
      FROM stale_proposals
    `,
    [reviewRunIds, summary, `${reason}_patch_proposal`],
  );
}

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
  const cancelled = result.rows.length === 1;
  if (cancelled) await markPatchProposalsStale(client, [runId], 'cancelled');
  return cancelled;
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
  const supersededRunIds = result.rows.map((row) => row.id);
  await markPatchProposalsStale(client, supersededRunIds, 'superseded');
  return supersededRunIds;
}
