import {
  modelInvocationEventSchema,
  type ModelInvocationEvent,
} from '@walkz/contracts';
import type { Pool } from 'pg';
import { z } from 'zod';

const persistenceInputSchema = modelInvocationEventSchema.extend({
  reviewRunId: z.uuid(),
}).strict();

const storedInvocationSchema = z.object({
  id: z.uuid(),
  status: z.enum(['succeeded', 'failed']),
  attemptCount: z.number().int().positive(),
}).strict();

export interface StoredModelInvocation {
  id: string;
  status: 'succeeded' | 'failed';
  attemptCount: number;
}

export async function recordModelInvocation(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<StoredModelInvocation> {
  const invocation = persistenceInputSchema.parse(input);
  const values = [
    invocation.reviewRunId,
    invocation.invocationKey,
    invocation.stage,
    invocation.status,
    invocation.provider,
    invocation.model,
    invocation.promptVersion,
    invocation.promptHash,
    invocation.responseHash,
    invocation.usage === null ? null : JSON.stringify(invocation.usage),
    invocation.requestId,
    invocation.errorCode,
    invocation.durationMs,
  ];
  const result = await pool.query(
    `INSERT INTO model_invocations (
       review_run_id, invocation_key, stage, status, provider, model,
       prompt_version, prompt_hash, response_hash, usage, request_id,
       error_code, duration_ms
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13
     )
     ON CONFLICT (review_run_id, invocation_key) DO UPDATE
     SET attempt_count = model_invocations.attempt_count + 1,
         status = CASE
           WHEN model_invocations.status = 'succeeded'
             THEN model_invocations.status
           ELSE EXCLUDED.status
         END,
         response_hash = CASE
           WHEN model_invocations.status = 'succeeded'
             THEN model_invocations.response_hash
           ELSE EXCLUDED.response_hash
         END,
         usage = CASE
           WHEN model_invocations.status = 'succeeded'
             THEN model_invocations.usage
           ELSE EXCLUDED.usage
         END,
         request_id = CASE
           WHEN model_invocations.status = 'succeeded'
             THEN model_invocations.request_id
           ELSE EXCLUDED.request_id
         END,
         error_code = CASE
           WHEN model_invocations.status = 'succeeded'
             THEN model_invocations.error_code
           ELSE EXCLUDED.error_code
         END,
         duration_ms = CASE
           WHEN model_invocations.status = 'succeeded'
             THEN model_invocations.duration_ms
           ELSE EXCLUDED.duration_ms
         END
     WHERE model_invocations.stage = EXCLUDED.stage
       AND model_invocations.provider = EXCLUDED.provider
       AND model_invocations.model = EXCLUDED.model
       AND model_invocations.prompt_version = EXCLUDED.prompt_version
       AND model_invocations.prompt_hash = EXCLUDED.prompt_hash
       AND (
         model_invocations.status = 'failed' OR
         EXCLUDED.status = 'failed' OR
         model_invocations.response_hash = EXCLUDED.response_hash
       )
     RETURNING id, status, attempt_count AS "attemptCount"`,
    values,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      'Model invocation replay conflicts with its immutable request or response.',
    );
  }
  return storedInvocationSchema.parse(row);
}

export type ModelInvocationPersistenceInput = ModelInvocationEvent & {
  reviewRunId: string;
};
