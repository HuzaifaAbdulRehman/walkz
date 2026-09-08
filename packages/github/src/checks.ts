import { z } from 'zod';

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);

export const reviewCheckConclusionSchema = z.enum([
  'success',
  'failure',
  'neutral',
  'cancelled',
  'timed_out',
  'action_required',
]);

export const reviewCheckAnnotationSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    level: z.enum(['notice', 'warning', 'failure']),
    message: z.string().trim().min(1).max(1_024),
  })
  .strict()
  .refine((annotation) => annotation.endLine >= annotation.startLine, {
    message: 'Check annotation lines must be ordered.',
    path: ['endLine'],
  });

export const reviewCheckPayloadSchema = z
  .object({
    name: z.literal('Walkz / review'),
    headSha: shaSchema,
    baseSha: shaSchema,
    status: z.enum(['queued', 'in_progress', 'completed']),
    conclusion: reviewCheckConclusionSchema.nullable(),
    summary: z.string().trim().min(1).max(65_536),
    annotations: z.array(reviewCheckAnnotationSchema).max(50),
  })
  .strict()
  .refine((check) => check.baseSha !== check.headSha, {
    message: 'Checks must compare distinct base and head commits.',
    path: ['headSha'],
  })
  .refine((check) => check.status !== 'completed' || check.conclusion !== null, {
    message: 'Completed checks require a conclusion.',
    path: ['conclusion'],
  });

export type ReviewCheckPayload = z.infer<typeof reviewCheckPayloadSchema>;

export function parseReviewCheckPayload(input: unknown): ReviewCheckPayload {
  return reviewCheckPayloadSchema.parse(input);
}
