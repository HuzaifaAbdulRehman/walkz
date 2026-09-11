import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());

export const patchFixStatusSchema = z.enum([
  'awaiting_approval',
  'queued',
  'reproving',
  'resolved',
  'unresolved',
  'inconclusive',
  'rejected',
  'failed',
]);

export const patchFixFailureCodeSchema = z.enum([
  'candidate_changed',
  'proof_binding_invalid',
  'proof_infrastructure_failed',
  'github_publication_failed',
  'workflow_failed',
]);

export const patchFixJobSchema = z
  .object({
    proposalId: z.uuid(),
    provider: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(512),
    promptVersion: z.string().trim().min(1).max(256),
    proofPlanDigest: sha256Schema,
    proofCommandDigest: sha256Schema,
    status: patchFixStatusSchema,
    attempt: z.number().int().nonnegative().max(100),
    failureCode: patchFixFailureCodeSchema.nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    completedAt: z.coerce.date().nullable(),
  })
  .strict()
  .superRefine((job, context) => {
    const terminal = new Set([
      'resolved',
      'unresolved',
      'inconclusive',
      'rejected',
      'failed',
    ]).has(job.status);
    if (terminal !== (job.completedAt !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Patch fix completion time must match its terminal state.',
        path: ['completedAt'],
      });
    }
    if ((job.status === 'failed') !== (job.failureCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only failed patch fix jobs may record a failure code.',
        path: ['failureCode'],
      });
    }
    if (
      job.updatedAt < job.createdAt ||
      (job.completedAt !== null && job.completedAt < job.createdAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Patch fix timestamps must not precede creation.',
        path: ['updatedAt'],
      });
    }
  });

export type PatchFixFailureCode = z.infer<typeof patchFixFailureCodeSchema>;
export type PatchFixJob = z.infer<typeof patchFixJobSchema>;
export type PatchFixStatus = z.infer<typeof patchFixStatusSchema>;

export function parsePatchFixJob(input: unknown): PatchFixJob {
  return patchFixJobSchema.parse(input);
}
