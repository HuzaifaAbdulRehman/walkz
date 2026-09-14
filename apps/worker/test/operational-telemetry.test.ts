import { describe, expect, it, vi } from 'vitest';

import {
  createStructuredOperationalLogger,
  createWorkerOperationalTelemetry,
} from '../src/operational-telemetry.js';

describe('worker operational telemetry', () => {
  it('records queue delay, duration, outcomes, and recovery in fixed dimensions', () => {
    let now = 1_000;
    const telemetry = createWorkerOperationalTelemetry(() => now);

    telemetry.recordStarted('reviews', 900);
    now = 1_125;
    telemetry.recordCompleted('reviews', 1_000);
    telemetry.recordFailed('reviews');
    telemetry.recordWorkerError('outbox');
    telemetry.recordRecovery('completed');

    expect(telemetry.snapshot()).toMatchObject({
      queues: {
        reviews: {
          started: 1,
          completed: 1,
          failed: 1,
          queueDelayMs: { count: 1, total: 100, maximum: 100 },
          processingDurationMs: { count: 1, total: 125, maximum: 125 },
        },
      },
      workerErrors: { outbox: 1 },
      recovery: { completed: 1, failed: 0 },
    });
  });

  it('clamps invalid timing data and returns detached snapshots', () => {
    const telemetry = createWorkerOperationalTelemetry(() => 100);

    telemetry.recordStarted('patch_fixes', Number.NaN);
    telemetry.recordCompleted('patch_fixes', 500);
    const first = telemetry.snapshot();
    first.queues.patch_fixes.started = 99;

    expect(telemetry.snapshot().queues.patch_fixes).toMatchObject({
      started: 1,
      completed: 1,
      queueDelayMs: { total: 0 },
      processingDurationMs: { total: 0 },
    });
  });

  it('writes only allowlisted structured fields', () => {
    const lines: string[] = [];
    const logger = createStructuredOperationalLogger(
      (line) => lines.push(line),
      () => '2026-09-14T12:00:00.000Z',
    );

    logger.write({ event: 'dependency_recovered', dependency: 'redis' });
    logger.write({ event: 'worker_error', queue: 'reviews' });
    logger.write({
      event: 'job_failed',
      queue: 'patch_fixes',
      attempt: 2,
      secret: 'do-not-log',
    } as never);

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        timestamp: '2026-09-14T12:00:00.000Z',
        level: 'info',
        service: 'worker',
        event: 'dependency_recovered',
        dependency: 'redis',
      },
      {
        timestamp: '2026-09-14T12:00:00.000Z',
        level: 'error',
        service: 'worker',
        event: 'worker_error',
        queue: 'reviews',
      },
      {
        timestamp: '2026-09-14T12:00:00.000Z',
        level: 'error',
        service: 'worker',
        event: 'job_failed',
        queue: 'patch_fixes',
        attempt: 2,
      },
    ]);
    expect(lines.join('')).not.toContain('do-not-log');
  });
});
