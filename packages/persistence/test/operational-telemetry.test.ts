import { describe, expect, it, vi } from 'vitest';

import { loadDurableOperationalTelemetry } from '../src/index.js';

describe('durable operational telemetry', () => {
  it('returns fixed review dimensions and bounded outbox age', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { status: 'completed', verdict: 'SHIP', count: '2' },
          { status: 'failed', verdict: null, count: '1' },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ pending: '3', oldestPendingAgeMs: '4200' }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    const snapshot = await loadDurableOperationalTelemetry(pool);

    expect(snapshot.windowHours).toBe(24);
    expect(snapshot.reviewRuns.byStatus).toMatchObject({
      completed: 2,
      failed: 1,
      queued: 0,
    });
    expect(snapshot.reviewRuns.byVerdict).toEqual({
      SHIP: 2,
      FIX: 0,
      HUMAN: 0,
      INCONCLUSIVE: 0,
      ERROR: 0,
    });
    expect(snapshot.outbox).toEqual({ pending: 3, oldestPendingAgeMs: 4200 });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('statement_timeout'),
      expect.stringContaining("interval '24 hours'"),
      expect.stringContaining('published_at IS NULL'),
      'COMMIT',
    ]);
    const sql = query.mock.calls.map(([value]) => String(value)).join('\n');
    expect(sql).not.toMatch(/summary|payload|prompt|response|credential/i);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects an unknown database dimension and rolls back', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ status: 'invented', verdict: null, count: '1' }],
      })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };

    await expect(loadDurableOperationalTelemetry(pool)).rejects.toThrow();

    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
