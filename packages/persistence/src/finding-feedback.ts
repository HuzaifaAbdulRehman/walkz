import {
  findingFeedbackAssessmentSchema,
  findingFeedbackReasonSchema,
} from '@walkz/contracts';
import type { Pool } from 'pg';
import { z } from 'zod';

const inputSchema = z.object({
  requestId: z.uuid(),
  repositoryId: z.uuid(),
  reviewRunId: z.uuid(),
  findingId: z.uuid(),
  actorUserId: z.uuid(),
  assessment: findingFeedbackAssessmentSchema,
  reason: findingFeedbackReasonSchema.nullable(),
}).strict().superRefine((feedback, context) => {
  if (feedback.assessment === 'correct' && feedback.reason !== null) {
    context.addIssue({
      code: 'custom',
      message: 'Correct findings cannot include a false-positive reason.',
      path: ['reason'],
    });
  }
});

const rowSchema = z.object({
  id: z.uuid(),
  reviewRunId: z.uuid(),
  findingId: z.uuid(),
  actorUserId: z.uuid(),
  assessment: findingFeedbackAssessmentSchema,
  reason: findingFeedbackReasonSchema.nullable(),
  createdAt: z.date(),
  created: z.boolean(),
}).strict();

export interface FindingFeedbackRecord {
  id: string;
  reviewRunId: string;
  findingId: string;
  actorUserId: string;
  assessment: 'correct' | 'false_positive';
  reason: 'incorrect_claim' | 'intentional_behavior' | 'not_actionable' |
    'duplicate' | 'other' | null;
  createdAt: Date;
}

export type RecordFindingFeedbackResult =
  | { outcome: 'created' | 'duplicate'; feedback: FindingFeedbackRecord }
  | { outcome: 'not_found' | 'conflict'; feedback: null };

export async function recordFindingFeedback(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<RecordFindingFeedbackResult> {
  const feedback = inputSchema.parse(input);
  const result = await pool.query(
    `WITH target AS (
       SELECT f.review_run_id, f.id AS finding_id
       FROM findings f
       JOIN review_runs rr ON rr.id = f.review_run_id
       WHERE rr.repository_id = $2
         AND f.review_run_id = $3
         AND f.id = $4
     ), inserted AS (
       INSERT INTO finding_feedback (
         request_id, review_run_id, finding_id, actor_user_id,
         assessment, reason
       )
       SELECT $1, review_run_id, finding_id, $5, $6, $7
       FROM target
       ON CONFLICT (request_id) DO NOTHING
       RETURNING id, review_run_id AS "reviewRunId",
         finding_id AS "findingId", actor_user_id AS "actorUserId",
         assessment, reason, created_at AS "createdAt", true AS created
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT ff.id, ff.review_run_id AS "reviewRunId",
       ff.finding_id AS "findingId", ff.actor_user_id AS "actorUserId",
       ff.assessment, ff.reason, ff.created_at AS "createdAt", false AS created
     FROM finding_feedback ff
     JOIN target ON true
     WHERE ff.request_id = $1 AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    [
      feedback.requestId,
      feedback.repositoryId,
      feedback.reviewRunId,
      feedback.findingId,
      feedback.actorUserId,
      feedback.assessment,
      feedback.reason,
    ],
  );
  if (result.rows.length === 0) return { outcome: 'not_found', feedback: null };
  const row = rowSchema.parse(result.rows[0]);
  if (
    row.reviewRunId !== feedback.reviewRunId ||
    row.findingId !== feedback.findingId ||
    row.actorUserId !== feedback.actorUserId ||
    row.assessment !== feedback.assessment ||
    row.reason !== feedback.reason
  ) {
    return { outcome: 'conflict', feedback: null };
  }
  const { created, ...stored } = row;
  return { outcome: created ? 'created' : 'duplicate', feedback: stored };
}
