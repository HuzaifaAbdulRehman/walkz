import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

export const reviewRunQueuedOutboxEventSchema = z
  .object({
    aggregateId: z.uuid(),
    eventType: z.literal('review_run.queued'),
    payload: z
      .object({
        reviewRunId: z.uuid(),
      })
      .strict(),
  })
  .strict()
  .refine((event) => event.aggregateId === event.payload.reviewRunId, {
    message: 'Outbox events must use the review run as their aggregate.',
    path: ['aggregateId'],
  });

export type ReviewRunQueuedOutboxEvent = z.infer<
  typeof reviewRunQueuedOutboxEventSchema
>;

export async function withTransaction<T>(
  pool: Pick<Pool, 'connect'>,
  operation: (client: Pick<PoolClient, 'query'>) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createReviewRunQueuedOutboxEvent(
  client: Pick<PoolClient, 'query'>,
  input: unknown,
): Promise<string> {
  const event = reviewRunQueuedOutboxEventSchema.parse(input);
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO outbox_events (aggregate_id, event_type, payload)
      VALUES ($1, $2, $3::jsonb)
      RETURNING id
    `,
    [event.aggregateId, event.eventType, JSON.stringify(event.payload)],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Outbox event insert did not return an ID.');
  }
  return row.id;
}
