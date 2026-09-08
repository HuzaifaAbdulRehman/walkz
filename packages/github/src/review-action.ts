import { z } from 'zod';

export const reviewTriggerSchema = z.enum([
  'manual',
  'ready_for_review',
  'synchronize',
]);

export const reviewTriggerPolicySchema = z
  .object({
    manual: z.boolean(),
    readyForReview: z.boolean(),
    everyPush: z.boolean(),
  })
  .strict();

export type ReviewTrigger = z.infer<typeof reviewTriggerSchema>;
export type ReviewTriggerPolicy = z.infer<typeof reviewTriggerPolicySchema>;

export function shouldStartReview(
  policyInput: unknown,
  triggerInput: unknown,
): boolean {
  const policy = reviewTriggerPolicySchema.parse(policyInput);
  const trigger = reviewTriggerSchema.parse(triggerInput);
  if (trigger === 'manual') return policy.manual;
  if (trigger === 'ready_for_review') return policy.readyForReview;
  return policy.everyPush;
}
