import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { ClaimedOutboxEvent } from '@walkz/persistence';

export const outboxQueueName = 'walkz-outbox';

export interface OutboxQueue {
  add(
    name: string,
    data: { eventId: string },
    options: { jobId: string },
  ): Promise<unknown>;
}

export async function enqueueOutboxEvent(
  queue: OutboxQueue,
  eventId: string,
): Promise<void> {
  await queue.add('dispatch', { eventId }, { jobId: eventId });
}

export function createOutboxQueue(connection: ConnectionOptions): Queue {
  return new Queue(outboxQueueName, { connection });
}

export interface OutboxEventStore {
  claim(input: {
    eventId: string;
    workerId: string;
    leaseMs: number;
  }): Promise<ClaimedOutboxEvent | null>;
  markPublished(input: {
    eventId: string;
    workerId: string;
    leaseMs: number;
  }): Promise<boolean>;
}

export interface OutboxEventHandler {
  handle(
    event: ClaimedOutboxEvent,
    input: { idempotencyKey: string },
  ): Promise<void>;
}

export async function dispatchOutboxEvent(
  store: OutboxEventStore,
  handler: OutboxEventHandler,
  input: { eventId: string; workerId: string; leaseMs: number },
): Promise<'skipped' | 'published'> {
  const event = await store.claim(input);
  if (event === null) {
    return 'skipped';
  }
  await handler.handle(event, { idempotencyKey: event.id });
  const marked = await store.markPublished(input);
  if (!marked) {
    throw new Error('Outbox event lease was lost before publication acknowledgement.');
  }
  return 'published';
}

export function createOutboxWorker(
  connection: ConnectionOptions,
  store: OutboxEventStore,
  handler: OutboxEventHandler,
  options: { workerId: string; leaseMs: number },
): Worker {
  return new Worker(
    outboxQueueName,
    async (job) => {
      const eventId = job.data?.eventId;
      if (typeof eventId !== 'string') {
        throw new Error('Outbox jobs must contain an event ID.');
      }
      return dispatchOutboxEvent(store, handler, {
        eventId,
        workerId: options.workerId,
        leaseMs: options.leaseMs,
      });
    },
    { connection },
  );
}
