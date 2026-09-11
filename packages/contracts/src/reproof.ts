import { z } from 'zod';

import { proofArtifactSchema } from './proof.js';

const sha1Schema = z.string().regex(/^[a-f0-9]{40}$/i)
  .transform((value) => value.toLowerCase());
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());

export const patchReproofCheckSchema = z.object({
  kind: z.enum(['proof', 'regression']),
  planDigest: sha256Schema,
  commandDigest: sha256Schema,
  outcome: z.enum([
    'passed',
    'failed',
    'timed_out',
    'cancelled',
    'infrastructure_error',
  ]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().max(5 * 60 * 1_000),
  sanitizedSummary: z.string().max(16_385),
  artifacts: z.array(proofArtifactSchema).max(32),
}).strict().superRefine((check, context) => {
  if (check.outcome === 'passed' && check.exitCode !== 0) {
    context.addIssue({
      code: 'custom',
      message: 'A passing reproof check must exit with code zero.',
      path: ['exitCode'],
    });
  }
  if (
    check.outcome === 'failed' &&
    (check.exitCode === null || check.exitCode === 0)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'A failing reproof check must have a nonzero exit code.',
      path: ['exitCode'],
    });
  }
});

export const patchReproofResultSchema = z.object({
  schemaVersion: z.literal(1),
  proposalId: z.uuid(),
  reviewRunId: z.uuid(),
  findingId: z.uuid(),
  attempt: z.number().int().positive().max(100),
  patchHash: sha256Schema,
  headSha: sha1Schema,
  outcome: z.enum(['resolved', 'unresolved', 'inconclusive']),
  proof: patchReproofCheckSchema,
  regressions: z.array(patchReproofCheckSchema).max(8),
  recordedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((result, context) => {
  if (result.proof.kind !== 'proof') {
    context.addIssue({
      code: 'custom',
      message: 'The primary reproof check must be a proof.',
      path: ['proof', 'kind'],
    });
  }
  result.regressions.forEach((check, index) => {
    if (check.kind !== 'regression') {
      context.addIssue({
        code: 'custom',
        message: 'Regression results must be regression checks.',
        path: ['regressions', index, 'kind'],
      });
    }
  });
  const checks = [result.proof, ...result.regressions];
  const hasIncomplete = checks.some((check) =>
    check.outcome === 'timed_out' ||
    check.outcome === 'cancelled' ||
    check.outcome === 'infrastructure_error');
  const hasFailure = checks.some((check) => check.outcome === 'failed');
  const expected = hasFailure
    ? 'unresolved'
    : hasIncomplete
      ? 'inconclusive'
      : 'resolved';
  if (result.outcome !== expected) {
    context.addIssue({
      code: 'custom',
      message: 'Patch reproof outcome does not match its required checks.',
      path: ['outcome'],
    });
  }
});

export type PatchReproofCheck = z.infer<typeof patchReproofCheckSchema>;
export type PatchReproofResult = z.infer<typeof patchReproofResultSchema>;

export function parsePatchReproofResult(input: unknown): PatchReproofResult {
  return patchReproofResultSchema.parse(input);
}
