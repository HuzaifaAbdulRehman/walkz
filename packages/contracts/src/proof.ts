import { z } from 'zod';

const sha1Schema = z.string().regex(/^[a-f0-9]{40}$/i);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const noControlString = z
  .string()
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'Control characters are not allowed.',
  });

function isSafeContainerPath(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\')) {
    return false;
  }
  const segments = value.split('/');
  return segments.every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
  );
}

const proofFilePathSchema = noControlString
  .min(1)
  .max(1_024)
  .refine(isSafeContainerPath, {
    message: 'Proof file paths must be normalized container-relative paths.',
  });

const proofWorkingDirectorySchema = noControlString
  .min(1)
  .max(1_024)
  .refine(
    (value) => value === '.' || isSafeContainerPath(value),
    {
      message: 'Proof working directories must stay inside the workspace.',
    },
  );

export const proofCommandSchema = z
  .object({
    executable: noControlString.trim().min(1).max(260),
    args: z.array(noControlString.max(4_096)).max(64),
    cwd: proofWorkingDirectorySchema,
  })
  .strict();

export const proofResourceLimitsSchema = z
  .object({
    timeoutMs: z.number().int().min(100).max(5 * 60 * 1_000),
    maxOutputBytesPerStream: z
      .number()
      .int()
      .min(1_024)
      .max(1024 * 1_024),
    memoryBytes: z
      .number()
      .int()
      .min(64 * 1_024 * 1_024)
      .max(2 * 1_024 * 1_024 * 1_024),
    nanoCpus: z.number().int().min(100_000_000).max(4_000_000_000),
    pidsLimit: z.number().int().min(16).max(256),
    maxWritableBytes: z
      .number()
      .int()
      .min(1024 * 1_024)
      .max(256 * 1_024 * 1_024),
  })
  .strict();

export const proofFileSchema = z
  .object({
    path: proofFilePathSchema,
    contentBase64: z.string().max(350_000),
    sha256: sha256Schema,
  })
  .strict();

export const proofPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: noControlString.trim().min(1).max(128),
    findingFingerprint: sha256Schema,
    baseSha: sha1Schema,
    headSha: sha1Schema,
    containerImage: noControlString
      .trim()
      .max(512)
      .regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/i),
    command: proofCommandSchema,
    commandDigest: sha256Schema,
    files: z.array(proofFileSchema).max(16),
    limits: proofResourceLimitsSchema,
  })
  .strict()
  .superRefine((plan, context) => {
    if (plan.baseSha.toLowerCase() === plan.headSha.toLowerCase()) {
      context.addIssue({
        code: 'custom',
        message: 'Base and head revisions must differ.',
        path: ['headSha'],
      });
    }

    const paths = new Set<string>();
    plan.files.forEach((file, index) => {
      const comparisonPath = file.path.toLowerCase();
      if (paths.has(comparisonPath)) {
        context.addIssue({
          code: 'custom',
          message: 'Proof file paths must be unique across platforms.',
          path: ['files', index, 'path'],
        });
      }
      paths.add(comparisonPath);
    });
  });

export const proofArtifactSchema = z
  .object({
    kind: z.enum(['stdout', 'stderr', 'file']),
    sha256: sha256Schema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const sanitizedProofOutputSchema = z
  .object({
    summary: z.string().max(8_192),
    originalBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    redacted: z.boolean(),
  })
  .strict();

export const proofExecutionResultSchema = z
  .object({
    revision: z.enum(['base', 'head']),
    sha: sha1Schema,
    outcome: z.enum([
      'passed',
      'failed',
      'timed_out',
      'cancelled',
      'infrastructure_error',
    ]),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    stdout: sanitizedProofOutputSchema,
    stderr: sanitizedProofOutputSchema,
    artifacts: z.array(proofArtifactSchema).max(32),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.outcome === 'passed' && result.exitCode !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'A passing proof must exit with code zero.',
        path: ['exitCode'],
      });
    }
    if (
      result.outcome === 'failed' &&
      (result.exitCode === null || result.exitCode === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A failing proof must have a nonzero exit code.',
        path: ['exitCode'],
      });
    }
  });

export type ProofCommand = z.infer<typeof proofCommandSchema>;
export type ProofResourceLimits = z.infer<typeof proofResourceLimitsSchema>;
export type ProofFile = z.infer<typeof proofFileSchema>;
export type ProofPlan = z.infer<typeof proofPlanSchema>;
export type ProofArtifact = z.infer<typeof proofArtifactSchema>;
export type SanitizedProofOutput = z.infer<
  typeof sanitizedProofOutputSchema
>;
export type ProofExecutionResult = z.infer<
  typeof proofExecutionResultSchema
>;

export function parseProofPlan(input: unknown): ProofPlan {
  return proofPlanSchema.parse(input);
}

export function parseProofExecutionResult(
  input: unknown,
): ProofExecutionResult {
  return proofExecutionResultSchema.parse(input);
}
