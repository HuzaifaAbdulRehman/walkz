import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());
const boundedTextSchema = z.string().trim().min(1).max(512)
  .refine((value) => !value.includes('\0'), {
    message: 'Model invocation metadata must not contain NUL bytes.',
  });

export const modelInvocationStageSchema = z.enum([
  'review',
  'patch',
  'challenger',
  'security',
]);

export const modelInvocationStatusSchema = z.enum([
  'succeeded',
  'failed',
]);

const providerRateLimitSchema = z.object({
  retryAfterMs: z.number().int().nonnegative().nullable(),
  remainingRequests: z.number().int().nonnegative().nullable(),
  remainingTokens: z.number().int().nonnegative().nullable(),
  resetRequests: z.string().max(128).nullable(),
  resetTokens: z.string().max(128).nullable(),
}).strict();

const providerUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  rateLimit: providerRateLimitSchema,
}).strict().refine(
  (usage) => usage.totalTokens === usage.promptTokens + usage.completionTokens,
  { message: 'Total tokens must equal prompt plus completion tokens.' },
);

export const modelInvocationEventSchema = z.object({
  invocationKey: sha256Schema,
  stage: modelInvocationStageSchema,
  status: modelInvocationStatusSchema,
  provider: boundedTextSchema,
  model: boundedTextSchema,
  promptVersion: boundedTextSchema,
  promptHash: sha256Schema,
  responseHash: sha256Schema.nullable(),
  usage: providerUsageSchema.nullable(),
  requestId: boundedTextSchema.nullable(),
  errorCode: z.string().trim().min(1).max(128).regex(/^[a-z0-9_]+$/).nullable(),
  durationMs: z.number().int().nonnegative().max(60 * 60 * 1_000),
}).strict().superRefine((event, context) => {
  if (event.status === 'succeeded') {
    if (event.responseHash === null) {
      context.addIssue({
        code: 'custom',
        message: 'Successful model invocations require a response hash.',
        path: ['responseHash'],
      });
    }
    if (event.usage === null) {
      context.addIssue({
        code: 'custom',
        message: 'Successful model invocations require usage metadata.',
        path: ['usage'],
      });
    }
    if (event.errorCode !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Successful model invocations cannot include an error code.',
        path: ['errorCode'],
      });
    }
  } else if (event.responseHash !== null || event.usage !== null) {
    context.addIssue({
      code: 'custom',
      message: 'Failed model invocations cannot claim a response or usage result.',
      path: ['status'],
    });
  } else if (event.errorCode === null) {
    context.addIssue({
      code: 'custom',
      message: 'Failed model invocations require an error code.',
      path: ['errorCode'],
    });
  }
});

export type ModelInvocationEvent = z.infer<typeof modelInvocationEventSchema>;
export type ModelInvocationStage = z.infer<typeof modelInvocationStageSchema>;
export type ModelInvocationStatus = z.infer<typeof modelInvocationStatusSchema>;

export function parseModelInvocationEvent(input: unknown): ModelInvocationEvent {
  return modelInvocationEventSchema.parse(input);
}
