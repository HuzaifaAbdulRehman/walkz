import type { Pool } from 'pg';
import { reviewRunStatusSchema, type ReviewRunStatus } from '@walkz/contracts';
import { z } from 'zod';

import { withTransaction } from './outbox.js';

const reviewVerdictSchema = z.enum([
  'SHIP',
  'FIX',
  'HUMAN',
  'INCONCLUSIVE',
  'ERROR',
]);
const countTextSchema = z.string().regex(/^\d+$/);
const reviewCountRowSchema = z.object({
  status: reviewRunStatusSchema,
  verdict: reviewVerdictSchema.nullable(),
  count: countTextSchema,
}).strict();
const outboxCountRowSchema = z.object({
  pending: countTextSchema,
  oldestPendingAgeMs: countTextSchema.nullable(),
}).strict();

type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

export interface DurableOperationalTelemetry {
  windowHours: 24;
  reviewRuns: {
    byStatus: Record<ReviewRunStatus, number>;
    byVerdict: Record<ReviewVerdict, number>;
  };
  outbox: {
    pending: number;
    oldestPendingAgeMs: number | null;
  };
}

function zeroRecord<const T extends readonly string[]>(values: T): Record<T[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T[number], number>;
}

function parseCount(value: string): number {
  const parsed = BigInt(countTextSchema.parse(value));
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Operational count exceeds the safe integer range.');
  }
  return Number(parsed);
}

export async function loadDurableOperationalTelemetry(
  pool: Pick<Pool, 'connect'>,
): Promise<DurableOperationalTelemetry> {
  return withTransaction(pool, async (client) => {
    await client.query("SET LOCAL statement_timeout = '1000ms'");
    const reviewResult = await client.query(
      `
        SELECT status, verdict, COUNT(*)::text AS count
        FROM review_runs
        WHERE created_at >= clock_timestamp() - interval '24 hours'
        GROUP BY status, verdict
      `,
    );
    const outboxResult = await client.query(
      `
        SELECT
          COUNT(*)::text AS pending,
          CASE WHEN MIN(created_at) IS NULL THEN NULL ELSE
            GREATEST(
              0,
              FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - MIN(created_at))) * 1000)
            )::bigint::text
          END AS "oldestPendingAgeMs"
        FROM outbox_events
        WHERE published_at IS NULL
      `,
    );

    const byStatus = zeroRecord(reviewRunStatusSchema.options);
    const byVerdict = zeroRecord(reviewVerdictSchema.options);
    for (const input of reviewResult.rows) {
      const row = reviewCountRowSchema.parse(input);
      const count = parseCount(row.count);
      byStatus[row.status] += count;
      if (row.verdict !== null) byVerdict[row.verdict] += count;
    }

    const outboxRow = outboxCountRowSchema.parse(outboxResult.rows[0]);
    const pending = parseCount(outboxRow.pending);
    const oldestPendingAgeMs = outboxRow.oldestPendingAgeMs === null
      ? null
      : parseCount(outboxRow.oldestPendingAgeMs);
    if ((pending === 0) !== (oldestPendingAgeMs === null)) {
      throw new Error('Outbox telemetry count and age are inconsistent.');
    }

    return {
      windowHours: 24,
      reviewRuns: { byStatus, byVerdict },
      outbox: { pending, oldestPendingAgeMs },
    };
  });
}
