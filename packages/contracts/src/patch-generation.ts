import { z } from 'zod';

const sha1Schema = z.string().regex(/^[a-f0-9]{40}$/i);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const noNulTextSchema = z.string().refine((value) => !value.includes('\0'), {
  message: 'Patch text must not contain NUL bytes.',
});

export const patchPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      value === value.trim() &&
      !value.includes('\\') &&
      !/^(?:[A-Za-z]:|\/)/.test(value) &&
      value.split('/').every(
        (segment) =>
          segment.length > 0 &&
          segment !== '.' &&
          segment !== '..' &&
          segment.toLowerCase() !== '.git',
      ),
    {
      message: 'Patch paths must be normalized repository-relative paths.',
    },
  )
  .refine((value) => !/[\u0000-\u001F\u007F]/u.test(value), {
    message: 'Patch paths must not contain control characters.',
  });

export const modelPatchResponseSchema = z
  .object({
    findingId: z.uuid(),
    headSha: sha1Schema,
    path: patchPathSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    replacement: noNulTextSchema.max(64 * 1_024),
    approvalRequired: z.literal(true),
  })
  .strict()
  .refine((patch) => patch.endLine >= patch.startLine, {
    message: 'Patch end line must not precede its start line.',
    path: ['endLine'],
  })
  .refine((patch) => patch.endLine - patch.startLine < 100, {
    message: 'A patch may replace at most 100 source lines.',
    path: ['endLine'],
  })
  .refine(
    (patch) => patch.replacement.split(/\r\n|\r|\n/u).length <= 200,
    {
      message: 'A patch replacement may contain at most 200 lines.',
      path: ['replacement'],
    },
  );

export const patchCandidateSchema = modelPatchResponseSchema
  .extend({
    schemaVersion: z.literal(1),
    reviewRunId: z.uuid(),
    baseSha: sha1Schema,
    deliveryMode: z.enum(['suggestion', 'fix_branch']),
    originalHash: sha256Schema,
    patchHash: sha256Schema,
  })
  .strict()
  .refine((patch) => patch.baseSha !== patch.headSha, {
    message: 'Patch candidates must target a changed head revision.',
    path: ['headSha'],
  });

export type ModelPatchResponse = z.infer<typeof modelPatchResponseSchema>;
export type PatchCandidate = z.infer<typeof patchCandidateSchema>;

export function parseModelPatchResponse(input: unknown): ModelPatchResponse {
  return modelPatchResponseSchema.parse(input);
}

export function parsePatchCandidate(input: unknown): PatchCandidate {
  return patchCandidateSchema.parse(input);
}
