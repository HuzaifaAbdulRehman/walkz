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

export const patchFixQueuedOutboxEventSchema = z
  .object({
    aggregateId: z.uuid(),
    eventType: z.literal('patch_fix.queued'),
    payload: z
      .object({
        proposalId: z.uuid(),
      })
      .strict(),
  })
  .strict()
  .refine((event) => event.aggregateId === event.payload.proposalId, {
    message: 'Outbox events must use the patch proposal as their aggregate.',
    path: ['aggregateId'],
  });

export type PatchFixQueuedOutboxEvent = z.infer<
  typeof patchFixQueuedOutboxEventSchema
>;

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const githubIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, {
    message: 'GitHub IDs must fit PostgreSQL BIGINT.',
  });

export const githubCheckVerdictSchema = z.enum([
  'SHIP',
  'FIX',
  'HUMAN',
  'INCONCLUSIVE',
  'ERROR',
]);

export const githubCheckResultFindingSchema = z
  .object({
    path: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .refine(
        (value) =>
          !value.startsWith('/') &&
          !value.includes('\\') &&
          !value.split('/').some((segment) =>
            segment === '' || segment === '.' || segment === '..'),
        { message: 'Finding paths must be normalized repository-relative paths.' },
      ),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    summary: z.string().trim().min(1).max(1_024),
  })
  .strict()
  .refine((finding) => finding.endLine >= finding.startLine, {
    message: 'Finding lines must be ordered.',
    path: ['endLine'],
  });

export const githubCheckQueuedOutboxEventSchema = z
  .object({
    aggregateId: z.uuid(),
    eventType: z.literal('github_check.queued'),
    payload: z
      .object({
        reviewRunId: z.uuid(),
        installationId: githubIdSchema,
        owner: z.string().trim().min(1).max(100),
        repository: z.string().trim().min(1).max(100),
        baseSha: shaSchema,
        headSha: shaSchema,
      })
      .strict(),
  })
  .strict()
  .refine((event) => event.aggregateId === event.payload.reviewRunId, {
    message: 'Outbox events must use the review run as their aggregate.',
    path: ['aggregateId'],
  })
  .refine((event) => event.payload.baseSha !== event.payload.headSha, {
    message: 'Queued checks require different base and head commits.',
    path: ['payload', 'headSha'],
  });

export type GitHubCheckQueuedOutboxEvent = z.infer<
  typeof githubCheckQueuedOutboxEventSchema
>;

export const githubCheckCompletedOutboxEventSchema = z
  .object({
    aggregateId: z.uuid(),
    eventType: z.literal('github_check.completed'),
    payload: z
      .object({
        reviewRunId: z.uuid(),
        installationId: githubIdSchema,
        owner: z.string().trim().min(1).max(100),
        repository: z.string().trim().min(1).max(100),
        baseSha: shaSchema,
        headSha: shaSchema,
        verdict: githubCheckVerdictSchema,
        summary: z.string().trim().min(1).max(65_536),
        findings: z.array(githubCheckResultFindingSchema).max(50),
      })
      .strict(),
  })
  .strict()
  .refine((event) => event.aggregateId === event.payload.reviewRunId, {
    message: 'Outbox events must use the review run as their aggregate.',
    path: ['aggregateId'],
  })
  .refine((event) => event.payload.baseSha !== event.payload.headSha, {
    message: 'Completed checks require different base and head commits.',
    path: ['payload', 'headSha'],
  });

export type GitHubCheckCompletedOutboxEvent = z.infer<
  typeof githubCheckCompletedOutboxEventSchema
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
  listRecoverableEventIds(limit: number): Promise<string[]>;
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

export async function createPatchFixQueuedOutboxEvent(
  client: Pick<PoolClient, 'query'>,
  input: unknown,
): Promise<string> {
  const event = patchFixQueuedOutboxEventSchema.parse(input);
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO outbox_events (aggregate_id, event_type, payload)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (aggregate_id, event_type)
        WHERE event_type = 'patch_fix.queued'
        DO UPDATE SET aggregate_id = EXCLUDED.aggregate_id
      RETURNING id
    `,
    [event.aggregateId, event.eventType, JSON.stringify(event.payload)],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Patch fix outbox event insert did not return an ID.');
  }
  return row.id;
}

export async function createGitHubCheckQueuedOutboxEvent(
  client: Pick<PoolClient, 'query'>,
  input: unknown,
): Promise<string> {
  const event = githubCheckQueuedOutboxEventSchema.parse(input);
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

export async function createGitHubCheckCompletedOutboxEvent(
  client: Pick<PoolClient, 'query'>,
  input: unknown,
): Promise<string> {
  const event = githubCheckCompletedOutboxEventSchema.parse(input);
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
        AND NOT EXISTS (
          SELECT 1
          FROM outbox_events earlier
          WHERE earlier.aggregate_id = outbox_events.aggregate_id
            AND earlier.published_at IS NULL
            AND (earlier.created_at, earlier.id) <
                (outbox_events.created_at, outbox_events.id)
        )
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

export async function listRecoverableOutboxEventIds(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<string[]> {
  const limit = z.number().int().min(1).max(1_000).parse(input);
  const result = await pool.query<{ id: string }>(
    `
      SELECT id
      FROM outbox_events
      WHERE published_at IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      ORDER BY created_at ASC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map((row) => row.id);
}

export function createOutboxEventStore(
  pool: Pick<Pool, 'connect' | 'query'>,
): OutboxEventStore {
  return {
    claim: (input) =>
      withTransaction(pool, (client) => claimOutboxEvent(client, input)),
    markPublished: (input) =>
      withTransaction(pool, (client) => markOutboxEventPublished(client, input)),
    listRecoverableEventIds: (limit) => listRecoverableOutboxEventIds(pool, limit),
  };
}
