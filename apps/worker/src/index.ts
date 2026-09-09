import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { ClaimedOutboxEvent } from '@walkz/persistence';

export { createGitHubCheckOutboxHandler } from './github-check-handler.js';
export type { InstallationReviewCheckPublisherFactory } from './github-check-handler.js';
export { createHostedOutboxHandler } from './hosted-outbox-handler.js';
export type { CheckOutboxHandler } from './hosted-outbox-handler.js';
export {
  createReviewQueue,
  createReviewWorker,
  enqueueReviewRun,
  recoverReviewRuns,
  reviewQueueName,
} from './review-queue.js';
export type { ReviewJobHandler, ReviewQueue } from './review-queue.js';
export { createHostedReviewJobHandler } from './hosted-review-handler.js';
export type {
  HostedInstallationTokens,
  HostedReviewHandlerOptions,
  HostedReviewStore,
} from './hosted-review-handler.js';

export const outboxQueueName = 'walkz-outbox';

export interface OutboxQueue {
  add(
    name: string,
    data: { eventId: string },
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: 'exponential'; delay: number };
      removeOnComplete: true;
      removeOnFail: true;
    },
  ): Promise<unknown>;
}

export async function enqueueOutboxEvent(
  queue: OutboxQueue,
  eventId: string,
): Promise<void> {
  await queue.add('dispatch', { eventId }, {
    jobId: eventId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}

export async function recoverOutboxEvents(
  queue: OutboxQueue,
  store: Pick<OutboxEventStore, 'listRecoverableEventIds'>,
  limit: number,
): Promise<number> {
  const eventIds = await store.listRecoverableEventIds(limit);
  for (const eventId of eventIds) {
    await enqueueOutboxEvent(queue, eventId);
  }
  return eventIds.length;
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
  listRecoverableEventIds(limit: number): Promise<string[]>;
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
