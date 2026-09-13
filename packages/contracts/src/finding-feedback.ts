import { z } from 'zod';

export const findingFeedbackAssessmentSchema = z.enum([
  'correct',
  'false_positive',
]);

export const findingFeedbackReasonSchema = z.enum([
  'incorrect_claim',
  'intentional_behavior',
  'not_actionable',
  'duplicate',
  'other',
]);

export const findingFeedbackRequestSchema = z.object({
  requestId: z.uuid(),
  assessment: findingFeedbackAssessmentSchema,
  reason: findingFeedbackReasonSchema.nullable().default(null),
}).strict().superRefine((feedback, context) => {
  if (feedback.assessment === 'correct' && feedback.reason !== null) {
    context.addIssue({
      code: 'custom',
      message: 'Correct findings cannot include a false-positive reason.',
      path: ['reason'],
    });
  }
});

export type FindingFeedbackAssessment = z.infer<
  typeof findingFeedbackAssessmentSchema
>;
export type FindingFeedbackReason = z.infer<typeof findingFeedbackReasonSchema>;
export type FindingFeedbackRequest = z.infer<typeof findingFeedbackRequestSchema>;

export function parseFindingFeedbackRequest(input: unknown): FindingFeedbackRequest {
  return findingFeedbackRequestSchema.parse(input);
}
