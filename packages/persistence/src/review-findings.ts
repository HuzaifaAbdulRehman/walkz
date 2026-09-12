import type { Pool } from 'pg';
import { z } from 'zod';

const reviewFindingQuerySchema = z.object({
  repositoryId: z.uuid(),
  reviewRunId: z.uuid(),
}).strict();

const reviewFindingSchema = z.object({
  id: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  category: z.enum([
    'correctness',
    'security',
    'performance',
    'reliability',
    'maintainability',
  ]).nullable(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).nullable(),
  path: z.string().nullable(),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
  lifecycleStatus: z.enum([
    'proposed',
    'challenged',
    'proving',
    'verified',
    'supported',
    'unverified',
    'dismissed',
    'fixed',
  ]),
  evidenceLevel: z.enum(['VERIFIED', 'SUPPORTED', 'UNVERIFIED']),
  advisoryConfidence: z.number().min(0).max(1).nullable(),
  summary: z.string(),
  claim: z.string().nullable(),
  failureMechanism: z.string().nullable(),
  suggestedProof: z.string().nullable(),
  createdAt: z.date(),
}).strict().refine(
  (finding) =>
    finding.startLine === null ||
    finding.endLine === null ||
    finding.endLine >= finding.startLine,
  { message: 'Finding end line must not precede its start line.' },
);

export type ReviewFindingItem = z.infer<typeof reviewFindingSchema>;

export async function listReviewFindings(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<ReviewFindingItem[]> {
  const query = reviewFindingQuerySchema.parse(input);
  const result = await pool.query(
    `
      SELECT f.id,
             f.fingerprint,
             f.category,
             f.severity,
             f.file_path AS path,
             f.start_line AS "startLine",
             f.end_line AS "endLine",
             f.lifecycle_status AS "lifecycleStatus",
             f.evidence_level AS "evidenceLevel",
             f.advisory_confidence AS "advisoryConfidence",
             f.summary,
             f.claim,
             f.failure_mechanism AS "failureMechanism",
             f.suggested_proof AS "suggestedProof",
             f.created_at AS "createdAt"
      FROM findings f
      JOIN review_runs rr ON rr.id = f.review_run_id
      WHERE rr.repository_id = $1 AND f.review_run_id = $2
      ORDER BY f.created_at ASC, f.id ASC
      LIMIT 50
    `,
    [query.repositoryId, query.reviewRunId],
  );
  return result.rows.map((row) => reviewFindingSchema.parse(row));
}
