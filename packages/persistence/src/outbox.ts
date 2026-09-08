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

const outboxLeaseSchema = z
  .object({
    eventId: z.uuid(),
    workerId: z.string().trim().min(1).max(128),
    leaseMs: z.number().int().min(1_000).max(300_000),
  })
  .strict();

export interface ClaimedOutboxEvent {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
}

export interface OutboxEventLeaseInput {
  eventId: string;
  workerId: string;
  leaseMs: number;
}

export interface OutboxEventStore {
  claim(input: OutboxEventLeaseInput): Promise<ClaimedOutboxEvent | null>;
  markPublished(input: OutboxEventLeaseInput): Promise<boolean>;
}

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

export async function claimOutboxEvent(
  client: Pick<PoolClient, 'query'>,
  input: unknown,
): Promise<ClaimedOutboxEvent | null> {
  const lease = outboxLeaseSchema.parse(input);
  const result = await client.query<ClaimedOutboxEvent>(
    `
      UPDATE outbox_events
      SET attempts = attempts + 1,
          lease_owner = $2,
          lease_expires_at = now() + ($3 * interval '1 millisecond'),
          last_error = NULL
      WHERE id = $1
        AND published_at IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      RETURNING id, aggregate_id AS "aggregateId", event_type AS "eventType", payload
    `,
    [lease.eventId, lease.workerId, lease.leaseMs],
  );
  return result.rows[0] ?? null;
}

export async function markOutboxEventPublished(
  client: Pick<PoolClient, 'query'>,
  input: unknown,
): Promise<boolean> {
  const lease = outboxLeaseSchema.parse(input);
  const result = await client.query(
    `
      UPDATE outbox_events
      SET published_at = now(), lease_expires_at = NULL
      WHERE id = $1 AND lease_owner = $2 AND published_at IS NULL
      RETURNING id
    `,
    [lease.eventId, lease.workerId],
  );
  return result.rows.length === 1;
}

export function createOutboxEventStore(
  pool: Pick<Pool, 'connect'>,
): OutboxEventStore {
  return {
    claim: (input) =>
      withTransaction(pool, (client) => claimOutboxEvent(client, input)),
    markPublished: (input) =>
      withTransaction(pool, (client) => markOutboxEventPublished(client, input)),
  };
}
