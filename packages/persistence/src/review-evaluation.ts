import {
  parseReviewEvaluationSnapshot,
  type ReviewEvaluationSnapshot,
} from '@walkz/contracts';
import type { Pool } from 'pg';
import { z } from 'zod';

const exportInputSchema = z.object({
  actorUserId: z.uuid(),
  repositoryId: z.uuid(),
  cohortId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  createdAfter: z.date(),
  createdBefore: z.date(),
  limit: z.number().int().min(1).max(1_000).default(250),
}).strict().refine(
  (input) => input.createdAfter < input.createdBefore,
  {
    message: 'Evaluation start time must precede its end time.',
    path: ['createdBefore'],
  },
);

const exportRowSchema = z.object({
  reviewRunId: z.uuid(),
  configHash: z.string().regex(/^[a-f0-9]{64}$/i),
  provider: z.string().trim().min(1).max(512),
  model: z.string().trim().min(1).max(512),
  promptVersion: z.string().trim().min(1).max(512),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  findingId: z.uuid().nullable(),
  evidenceLevel: z.enum(['VERIFIED', 'SUPPORTED', 'UNVERIFIED']).nullable(),
  lifecycleStatus: z.enum([
    'proposed',
    'challenged',
    'proving',
    'verified',
    'supported',
    'unverified',
    'dismissed',
    'fixed',
  ]).nullable(),
  proofOutcome: z.enum([
    'verified',
    'not_verified',
    'incomplete',
    'not_requested',
  ]).nullable(),
  feedback: z.enum(['correct', 'false_positive']).nullable(),
}).strict().superRefine((row, context) => {
  const findingFields = [
    row.evidenceLevel,
    row.lifecycleStatus,
    row.proofOutcome,
  ];
  const hasFinding = row.findingId !== null;
  if (findingFields.some((value) => (value !== null) !== hasFinding)) {
    context.addIssue({
      code: 'custom',
      message: 'Evaluation finding metadata must be present as one bound record.',
      path: ['findingId'],
    });
  }
});

export interface ReviewEvaluationExportInput {
  actorUserId: string;
  repositoryId: string;
  cohortId: string;
  createdAfter: Date;
  createdBefore: Date;
  limit?: number;
}

interface ReviewEvaluationExportOptions {
  now?: () => Date;
}

export async function exportReviewEvaluationSnapshot(
  pool: Pick<Pool, 'query'>,
  input: ReviewEvaluationExportInput,
  options: ReviewEvaluationExportOptions = {},
): Promise<ReviewEvaluationSnapshot | null> {
  const selection = exportInputSchema.parse(input);
  const result = await pool.query(
    `WITH review_invocations AS (
       SELECT mi.*,
              row_number() OVER (
                PARTITION BY mi.review_run_id
                ORDER BY mi.created_at ASC, mi.id ASC
              ) AS invocation_order,
              count(*) OVER (PARTITION BY mi.review_run_id) AS invocation_count
       FROM model_invocations mi
       WHERE mi.stage = 'review'
         AND mi.status = 'succeeded'
     ), selected_runs AS (
       SELECT rr.id,
              rr.config_hash,
              mi.provider,
              mi.model,
              mi.prompt_version,
              (mi.usage->>'promptTokens')::integer AS prompt_tokens,
              (mi.usage->>'completionTokens')::integer AS completion_tokens,
              (mi.usage->>'totalTokens')::integer AS total_tokens,
              mi.duration_ms AS latency_ms
       FROM review_runs rr
       JOIN repositories r ON r.id = rr.repository_id
       JOIN user_repository_access ura
         ON ura.installation_id = r.installation_id
        AND ura.github_repository_id = r.github_id
        AND ura.user_id = $1
       JOIN review_invocations mi
         ON mi.review_run_id = rr.id
        AND mi.invocation_order = 1
        AND mi.invocation_count = 1
       WHERE rr.repository_id = $2
         AND rr.status IN ('completed', 'inconclusive')
         AND rr.created_at >= $3
         AND rr.created_at < $4
         AND (
           SELECT count(*) FROM findings bounded_finding
           WHERE bounded_finding.review_run_id = rr.id
         ) <= 50
       ORDER BY rr.created_at ASC, rr.id ASC
       LIMIT $5
     ), latest_feedback AS (
       SELECT DISTINCT ON (ff.finding_id)
              ff.finding_id,
              ff.assessment
       FROM finding_feedback ff
       JOIN findings feedback_finding ON feedback_finding.id = ff.finding_id
       JOIN selected_runs feedback_run
         ON feedback_run.id = feedback_finding.review_run_id
       ORDER BY ff.finding_id, ff.created_at DESC, ff.id DESC
     ), proof_outcomes AS (
       SELECT e.finding_id,
              CASE
                WHEN bool_or(
                  e.base_outcome = 'passed' AND e.head_outcome = 'failed'
                ) THEN 'verified'
                WHEN bool_or(
                  e.base_outcome IS NULL OR e.head_outcome IS NULL OR
                  e.base_outcome IN (
                    'timed_out', 'cancelled', 'infrastructure_error'
                  ) OR
                  e.head_outcome IN (
                    'timed_out', 'cancelled', 'infrastructure_error'
                  )
                ) THEN 'incomplete'
                ELSE 'not_verified'
              END AS proof_outcome
       FROM evidence e
       JOIN findings proof_finding ON proof_finding.id = e.finding_id
       JOIN selected_runs proof_run
         ON proof_run.id = proof_finding.review_run_id
       WHERE e.evidence_kind = 'counterfactual_proof'
       GROUP BY e.finding_id
     )
     SELECT sr.id AS "reviewRunId",
            sr.config_hash AS "configHash",
            sr.provider,
            sr.model,
            sr.prompt_version AS "promptVersion",
            sr.prompt_tokens AS "promptTokens",
            sr.completion_tokens AS "completionTokens",
            sr.total_tokens AS "totalTokens",
            sr.latency_ms AS "latencyMs",
            f.id AS "findingId",
            f.evidence_level AS "evidenceLevel",
            f.lifecycle_status AS "lifecycleStatus",
            CASE
              WHEN f.id IS NULL THEN NULL
              ELSE coalesce(po.proof_outcome, 'not_requested')
            END AS "proofOutcome",
            lf.assessment AS feedback
     FROM selected_runs sr
     LEFT JOIN findings f ON f.review_run_id = sr.id
     LEFT JOIN latest_feedback lf ON lf.finding_id = f.id
     LEFT JOIN proof_outcomes po ON po.finding_id = f.id
     ORDER BY sr.id ASC, f.created_at ASC, f.id ASC`,
    [
      selection.actorUserId,
      selection.repositoryId,
      selection.createdAfter,
      selection.createdBefore,
      selection.limit,
    ],
  );
  if (result.rows.length === 0) return null;

  const runs = new Map<string, ReviewEvaluationSnapshot['runs'][number]>();
  for (const rawRow of result.rows) {
    const row = exportRowSchema.parse(rawRow);
    const existing = runs.get(row.reviewRunId);
    const run = existing ?? {
      reviewRunId: row.reviewRunId,
      configHash: row.configHash,
      provider: row.provider,
      model: row.model,
      promptVersion: row.promptVersion,
      usage: {
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        latencyMs: row.latencyMs,
      },
      findings: [],
    };
    if (row.findingId !== null) {
      run.findings.push({
        findingId: row.findingId,
        evidenceLevel: row.evidenceLevel!,
        lifecycleStatus: row.lifecycleStatus!,
        proofOutcome: row.proofOutcome!,
        feedback: row.feedback,
      });
    }
    runs.set(row.reviewRunId, run);
  }

  return parseReviewEvaluationSnapshot({
    schemaVersion: 1,
    cohortId: selection.cohortId,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    runs: [...runs.values()],
  });
}
