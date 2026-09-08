import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

const auditEventSchema = z
  .object({
    actorUserId: z.uuid().nullable(),
    eventType: z.string().trim().min(1).max(128),
    summary: z.string().trim().min(1).max(512),
    metadata: z
      .object({
        operation: z.string().trim().min(1).max(128),
        outcome: z.enum(['accepted', 'rejected', 'completed', 'failed']),
        subjectId: z.uuid().nullable(),
      })
      .strict(),
  })
  .strict();

export async function recordAuditEvent(
  client: Pick<PoolClient, 'query'>,
  input: unknown,
): Promise<string> {
  const event = auditEventSchema.parse(input);
  const result = await client.query<{ id: string }>(
    `
      INSERT INTO audit_events (actor_user_id, event_type, summary, metadata)
      VALUES ($1, $2, $3, $4::jsonb)
      RETURNING id
    `,
    [
      event.actorUserId,
      event.eventType,
      event.summary,
      JSON.stringify(event.metadata),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Audit event storage did not return an ID.');
  }
  return row.id;
}

export async function purgeExpiredAuditEvents(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<number> {
  const before = z.coerce.date().parse(input);
  const result = await pool.query(
    'DELETE FROM audit_events WHERE created_at < $1',
    [before],
  );
  return result.rowCount ?? 0;
}
