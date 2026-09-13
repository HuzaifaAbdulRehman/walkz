import { z } from 'zod';

const boundedNameSchema = z.string().trim().min(1).max(512);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());
const evidenceLevelSchema = z.enum(['VERIFIED', 'SUPPORTED', 'UNVERIFIED']);
const findingLifecycleStatusSchema = z.enum([
  'proposed',
  'challenged',
  'proving',
  'verified',
  'supported',
  'unverified',
  'dismissed',
  'fixed',
]);

const evaluationFindingSchema = z.object({
  findingId: z.uuid(),
  evidenceLevel: evidenceLevelSchema,
  lifecycleStatus: findingLifecycleStatusSchema,
  proofOutcome: z.enum([
    'verified',
    'not_verified',
    'incomplete',
    'not_requested',
  ]),
  feedback: z.enum(['correct', 'false_positive']).nullable(),
}).strict().refine(
  (finding) =>
    finding.proofOutcome !== 'verified' || finding.evidenceLevel === 'VERIFIED',
  {
    message: 'Verified proof outcomes require verified evidence.',
    path: ['proofOutcome'],
  },
);

const evaluationUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
}).strict().refine(
  (usage) => usage.totalTokens === usage.promptTokens + usage.completionTokens,
  { message: 'Total tokens must equal prompt plus completion tokens.' },
);

const evaluationRunSchema = z.object({
  reviewRunId: z.uuid(),
  configHash: sha256Schema,
  provider: boundedNameSchema,
  model: boundedNameSchema,
  promptVersion: boundedNameSchema,
  usage: evaluationUsageSchema,
  findings: z.array(evaluationFindingSchema).max(50),
}).strict().superRefine((run, context) => {
  const findingIds = new Set<string>();
  run.findings.forEach((finding, index) => {
    if (findingIds.has(finding.findingId)) {
      context.addIssue({
        code: 'custom',
        message: 'Evaluation finding IDs must be unique within a review.',
        path: ['findings', index, 'findingId'],
      });
    }
    findingIds.add(finding.findingId);
  });
});

export const reviewEvaluationSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  cohortId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  createdAt: z.string().datetime({ offset: true }),
  runs: z.array(evaluationRunSchema).min(1).max(1_000),
}).strict().superRefine((snapshot, context) => {
  const runIds = new Set<string>();
  snapshot.runs.forEach((run, index) => {
    if (runIds.has(run.reviewRunId)) {
      context.addIssue({
        code: 'custom',
        message: 'Evaluation review run IDs must be unique.',
        path: ['runs', index, 'reviewRunId'],
      });
    }
    runIds.add(run.reviewRunId);
  });
});

export type ReviewEvaluationSnapshot = z.infer<
  typeof reviewEvaluationSnapshotSchema
>;

export function parseReviewEvaluationSnapshot(
  input: unknown,
): ReviewEvaluationSnapshot {
  return reviewEvaluationSnapshotSchema.parse(input);
}
