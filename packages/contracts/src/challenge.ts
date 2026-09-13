import { z } from 'zod';

const findingFingerprintSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());

export const modelChallengeVerdictSchema = z.enum([
  'uphold',
  'dispute',
  'needs_human',
]);

export const modelChallengeDecisionSchema = z
  .object({
    findingFingerprint: findingFingerprintSchema,
    rationale: z.string().trim().min(1).max(2_000),
    verdict: modelChallengeVerdictSchema,
  })
  .strict();

export const modelChallengeResponseSchema = z
  .object({
    decisions: z.array(modelChallengeDecisionSchema).min(1).max(20),
  })
  .strict()
  .superRefine((response, context) => {
    const fingerprints = new Set<string>();
    response.decisions.forEach((decision, index) => {
      if (fingerprints.has(decision.findingFingerprint)) {
        context.addIssue({
          code: 'custom',
          message: 'Challenge decision fingerprints must be unique.',
          path: ['decisions', index, 'findingFingerprint'],
        });
      }
      fingerprints.add(decision.findingFingerprint);
    });
  });

export type ModelChallengeVerdict = z.infer<
  typeof modelChallengeVerdictSchema
>;
export type ModelChallengeDecision = z.infer<
  typeof modelChallengeDecisionSchema
>;
export type ModelChallengeResponse = z.infer<
  typeof modelChallengeResponseSchema
>;

export function parseModelChallengeResponse(
  input: unknown,
): ModelChallengeResponse {
  if (typeof input !== 'string') {
    return modelChallengeResponseSchema.parse(input);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new SyntaxError('Model challenge response is not valid JSON.');
  }
  return modelChallengeResponseSchema.parse(parsed);
}
