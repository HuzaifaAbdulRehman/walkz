import { reviewRunStatusSchema } from '@walkz/contracts';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import {
  createGitHubCheckCompletedOutboxEvent,
  githubCheckCompletedOutboxEventSchema,
  githubCheckResultFindingSchema,
  githubCheckVerdictSchema,
  withTransaction,
} from './outbox.js';

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);

const completedReviewRunInputSchema = z
  .object({
    reviewRunId: z.uuid(),
    baseSha: shaSchema,
    headSha: shaSchema,
    verdict: githubCheckVerdictSchema,
    summary: z.string().trim().min(1).max(65_536),
    findings: z.array(githubCheckResultFindingSchema).max(50),
  })
  .strict()
  .refine((result) => result.baseSha !== result.headSha, {
    message: 'Review results must compare different base and head commits.',
    path: ['headSha'],
  });

const lockedReviewRunSchema = z
  .object({
    id: z.uuid(),
    status: reviewRunStatusSchema,
    baseSha: shaSchema,
    headSha: shaSchema,
    installationId: z.string(),
    owner: z.string(),
    repository: z.string(),
  })
  .strict();

const existingEventSchema = z
  .object({
    id: z.uuid(),
    payload: z.unknown(),
  })
  .strict();

export interface CompletedHostedReviewRun {
  reviewRunId: string;
  outboxEventId: string;
  created: boolean;
}

function terminalStatusForVerdict(
  verdict: z.infer<typeof githubCheckVerdictSchema>,
): 'completed' | 'inconclusive' | 'failed' {
  if (verdict === 'INCONCLUSIVE') return 'inconclusive';
  if (verdict === 'ERROR') return 'failed';
  return 'completed';
}

function samePayload(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function lockReviewRun(
  client: Pick<PoolClient, 'query'>,
  reviewRunId: string,
) {
  const result = await client.query(
    `
      SELECT rr.id,
             rr.status,
             rr.base_sha AS baseSha,
             rr.head_sha AS headSha,
             gi.github_id::text AS installationId,
             r.owner_login AS owner,
             r.repository_name AS repository
      FROM review_runs rr
      JOIN repositories r ON r.id = rr.repository_id
      JOIN github_installations gi ON gi.id = r.installation_id
      WHERE rr.id = $1
      FOR UPDATE OF rr
    `,
    [reviewRunId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Review run was not found.');
  }
  return lockedReviewRunSchema.parse(row);
}

async function findCompletedEvent(
  client: Pick<PoolClient, 'query'>,
  reviewRunId: string,
) {
  const result = await client.query(
    `
      SELECT id, payload
      FROM outbox_events
      WHERE aggregate_id = $1 AND event_type = 'github_check.completed'
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [reviewRunId],
  );
  const row = result.rows[0];
  return row === undefined ? null : existingEventSchema.parse(row);
}

export async function completeHostedReviewRun(
  pool: Pick<Pool, 'connect'>,
  input: unknown,
): Promise<CompletedHostedReviewRun> {
  const result = completedReviewRunInputSchema.parse(input);
  return withTransaction(pool, async (client) => {
    const run = await lockReviewRun(client, result.reviewRunId);
    if (run.baseSha !== result.baseSha || run.headSha !== result.headSha) {
      throw new Error('Review result revisions do not match the durable review run.');
    }

    const event = githubCheckCompletedOutboxEventSchema.parse({
      aggregateId: run.id,
      eventType: 'github_check.completed',
      payload: {
        reviewRunId: run.id,
        installationId: run.installationId,
        owner: run.owner,
        repository: run.repository,
        baseSha: run.baseSha,
        headSha: run.headSha,
        verdict: result.verdict,
        summary: result.summary,
        findings: result.findings,
      },
    });

    if (['completed', 'inconclusive', 'failed'].includes(run.status)) {
      const existing = await findCompletedEvent(client, run.id);
      if (
        existing === null ||
        !samePayload(
          githubCheckCompletedOutboxEventSchema.parse({
            aggregateId: run.id,
            eventType: 'github_check.completed',
            payload: existing.payload,
          }).payload,
          event.payload,
        )
      ) {
        throw new Error('Review run already has a different terminal result.');
      }
      return { reviewRunId: run.id, outboxEventId: existing.id, created: false };
    }
    if (run.status === 'cancelled' || run.status === 'superseded') {
      throw new Error(`Cannot complete a ${run.status} review run.`);
    }

    const terminalStatus = terminalStatusForVerdict(result.verdict);
    const updated = await client.query(
      `
        UPDATE review_runs
        SET status = $2,
            verdict = $3,
            result_summary = $4,
            completed_at = now()
        WHERE id = $1 AND status = $5
        RETURNING id
      `,
      [run.id, terminalStatus, result.verdict, result.summary, run.status],
    );
    if (updated.rows.length !== 1) {
      throw new Error('Review run changed while its result was being stored.');
    }
    const outboxEventId = await createGitHubCheckCompletedOutboxEvent(client, event);
    return { reviewRunId: run.id, outboxEventId, created: true };
  });
}
