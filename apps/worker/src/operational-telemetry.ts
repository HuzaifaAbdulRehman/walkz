import type { HostedReviewFailureStage } from './hosted-review-handler.js';

export const workerQueueNames = [
  'outbox',
  'comment_commands',
  'reviews',
  'patch_fixes',
] as const;

export type WorkerQueueName = typeof workerQueueNames[number];

interface TimingSummary {
  count: number;
  total: number;
  maximum: number;
}

interface QueueTelemetry {
  started: number;
  completed: number;
  failed: number;
  queueDelayMs: TimingSummary;
  processingDurationMs: TimingSummary;
}

export interface WorkerOperationalTelemetrySnapshot {
  uptimeSeconds: number;
  queues: Record<WorkerQueueName, QueueTelemetry>;
  workerErrors: Record<WorkerQueueName, number>;
  recovery: {
    completed: number;
    failed: number;
  };
}

export interface WorkerOperationalTelemetry {
  recordStarted(queue: WorkerQueueName, queuedAt: number): void;
  recordCompleted(queue: WorkerQueueName, processedAt: number | undefined): void;
  recordFailed(queue: WorkerQueueName): void;
  recordWorkerError(queue: WorkerQueueName): void;
  recordRecovery(outcome: 'completed' | 'failed'): void;
  snapshot(): WorkerOperationalTelemetrySnapshot;
}

function timingSummary(): TimingSummary {
  return { count: 0, total: 0, maximum: 0 };
}

function queueTelemetry(): QueueTelemetry {
  return {
    started: 0,
    completed: 0,
    failed: 0,
    queueDelayMs: timingSummary(),
    processingDurationMs: timingSummary(),
  };
}

function fixedRecord<T>(factory: () => T): Record<WorkerQueueName, T> {
  return Object.fromEntries(workerQueueNames.map((name) => [name, factory()])) as
    Record<WorkerQueueName, T>;
}

function elapsed(now: number, then: number | undefined): number {
  if (then === undefined || !Number.isFinite(then)) return 0;
  return Math.max(0, Math.round(now - then));
}

function observe(summary: TimingSummary, value: number): void {
  summary.count += 1;
  summary.total += value;
  summary.maximum = Math.max(summary.maximum, value);
}

function copyTiming(summary: TimingSummary): TimingSummary {
  return { ...summary };
}

function copyQueue(value: QueueTelemetry): QueueTelemetry {
  return {
    started: value.started,
    completed: value.completed,
    failed: value.failed,
    queueDelayMs: copyTiming(value.queueDelayMs),
    processingDurationMs: copyTiming(value.processingDurationMs),
  };
}

export function createWorkerOperationalTelemetry(
  now: () => number = Date.now,
): WorkerOperationalTelemetry {
  const startedAt = now();
  const queues = fixedRecord(queueTelemetry);
  const workerErrors = fixedRecord(() => 0);
  const recovery = { completed: 0, failed: 0 };

  return {
    recordStarted(queue, queuedAt) {
      queues[queue].started += 1;
      observe(queues[queue].queueDelayMs, elapsed(now(), queuedAt));
    },
    recordCompleted(queue, processedAt) {
      queues[queue].completed += 1;
      observe(queues[queue].processingDurationMs, elapsed(now(), processedAt));
    },
    recordFailed(queue) {
      queues[queue].failed += 1;
    },
    recordWorkerError(queue) {
      workerErrors[queue] += 1;
    },
    recordRecovery(outcome) {
      recovery[outcome] += 1;
    },
    snapshot() {
      return {
        uptimeSeconds: Math.max(0, Math.floor((now() - startedAt) / 1_000)),
        queues: Object.fromEntries(
          workerQueueNames.map((name) => [name, copyQueue(queues[name])]),
        ) as Record<WorkerQueueName, QueueTelemetry>,
        workerErrors: { ...workerErrors },
        recovery: { ...recovery },
      };
    },
  };
}

export type OperationalLogEvent =
  | { event: 'service_started' | 'service_stopped' }
  | { event: 'service_start_failed' | 'service_stop_failed' }
  | { event: 'worker_error'; queue: WorkerQueueName }
  | { event: 'job_failed'; queue: WorkerQueueName; attempt: number }
  | {
      event: 'hosted_review_failed';
      stage: HostedReviewFailureStage;
    }
  | { event: 'recovery_failed' }
  | {
      event: 'dependency_check_failed' | 'dependency_recovered';
      dependency: 'postgres' | 'redis';
    };

export interface StructuredOperationalLogger {
  write(event: OperationalLogEvent): void;
}

export function createStructuredOperationalLogger(
  writeLine: (line: string) => void = console.log,
  timestamp: () => string = () => new Date().toISOString(),
): StructuredOperationalLogger {
  return {
    write(input) {
      const base = {
        timestamp: timestamp(),
        level: input.event === 'service_started' ||
          input.event === 'service_stopped' ||
          input.event === 'dependency_recovered'
          ? 'info'
          : 'error',
        service: 'worker',
        event: input.event,
      };
      let record: Record<string, unknown> = base;
      if (input.event === 'worker_error') {
        record = { ...base, queue: input.queue };
      } else if (input.event === 'job_failed') {
        record = {
          ...base,
          queue: input.queue,
          attempt: Math.max(0, Math.trunc(input.attempt)),
        };
      } else if (input.event === 'hosted_review_failed') {
        record = { ...base, stage: input.stage };
      } else if (
        input.event === 'dependency_check_failed' ||
        input.event === 'dependency_recovered'
      ) {
        record = { ...base, dependency: input.dependency };
      }
      writeLine(JSON.stringify(record));
    },
  };
}
