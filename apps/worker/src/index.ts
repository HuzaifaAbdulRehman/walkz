import { Queue, type ConnectionOptions } from 'bullmq';

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
