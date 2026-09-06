import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const gitReferenceSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'), {
    message: 'Git references must not contain NUL bytes.',
  });
const pathStringSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes('\0'), {
    message: 'Repository paths must not contain NUL bytes.',
  });
const repositoryRootSchema = pathStringSchema;
const changedFilePathSchema = pathStringSchema.refine(
  (value) =>
    !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value) &&
    !value.split(/[\\/]/).includes('..'),
  {
    message: 'Repository paths must be relative and cannot traverse upward.',
  },
);

export const reviewRequestSchema = z
  .object({
    repositoryRoot: repositoryRootSchema,
    baseRef: gitReferenceSchema.nullable(),
    headRef: gitReferenceSchema.nullable(),
    trigger: z.enum(['local', 'staged', 'github']),
    configVersion: z.number().int().positive(),
    configHash: sha256Schema,
    runBudget: z
      .object({
        maxDurationMs: z.number().int().positive().max(60 * 60 * 1_000),
        maxModelTokens: z.number().int().nonnegative().max(1_000_000),
        maxProofAttempts: z.number().int().nonnegative().max(100),
      })
      .strict(),
    callerCapabilities: z
      .object({
        canRunCommands: z.boolean(),
        canUseModel: z.boolean(),
        canWriteFiles: z.boolean(),
      })
      .strict(),
    prNumber: z.number().int().positive().optional(),
  })
  .strict();

export const modelFindingSchema = z
  .object({
    category: z.enum([
      'correctness',
      'security',
      'performance',
      'reliability',
      'maintainability',
    ]),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    file: changedFilePathSchema,
    line: z.number().int().positive(),
    endLine: z.number().int().positive().optional(),
    claim: z.string().trim().min(1).max(2_000),
    failureMechanism: z.string().trim().min(1).max(4_000),
    suggestedProof: z.string().trim().min(1).max(4_000),
    confidence: z.number().min(0).max(1),
  })
  .strict()
  .refine(
    (finding) =>
      finding.endLine === undefined || finding.endLine >= finding.line,
    {
      message: 'endLine must be greater than or equal to line.',
      path: ['endLine'],
    },
  );

export const modelReviewResponseSchema = z
  .object({
    findings: z.array(modelFindingSchema).max(100),
  })
  .strict();

export type ReviewRequest = z.infer<typeof reviewRequestSchema>;
export type ModelFinding = z.infer<typeof modelFindingSchema>;
export type ModelReviewResponse = z.infer<typeof modelReviewResponseSchema>;

export function validateReviewRequest(input: unknown): ReviewRequest {
  return reviewRequestSchema.parse(input);
}

export function parseModelReviewResponse(input: unknown): ModelReviewResponse {
  if (typeof input !== 'string') {
    return modelReviewResponseSchema.parse(input);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new SyntaxError('Model response is not valid JSON.');
  }

  return modelReviewResponseSchema.parse(parsed);
}
