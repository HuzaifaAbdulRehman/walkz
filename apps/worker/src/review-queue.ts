import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { z } from 'zod';

export const reviewQueueName = 'walkz-reviews';

const reviewJobSchema = z.object({ reviewRunId: z.uuid() }).strict();

export interface ReviewQueue {
  add(
    name: string,
    data: { reviewRunId: string },
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: 'exponential'; delay: number };
      removeOnComplete: true;
      removeOnFail: true;
    },
  ): Promise<unknown>;
}

export interface ReviewJobHandler {
  handle(reviewRunId: string): Promise<void>;
}

export async function enqueueReviewRun(
  queue: ReviewQueue,
  reviewRunIdInput: unknown,
): Promise<void> {
  const { reviewRunId } = reviewJobSchema.parse({ reviewRunId: reviewRunIdInput });
  await queue.add('review', { reviewRunId }, {
    jobId: reviewRunId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}

export async function recoverReviewRuns(
  queue: ReviewQueue,
  store: { listRecoverableReviewRunIds(limit: number): Promise<string[]> },
  limit: number,
): Promise<number> {
  const reviewRunIds = await store.listRecoverableReviewRunIds(limit);
  await Promise.all(reviewRunIds.map((reviewRunId) =>
    enqueueReviewRun(queue, reviewRunId)));
  return reviewRunIds.length;
}

export function createReviewQueue(connection: ConnectionOptions): Queue {
  return new Queue(reviewQueueName, { connection });
}

export function createReviewWorker(
  connection: ConnectionOptions,
  handler: ReviewJobHandler,
): Worker {
  return new Worker(
    reviewQueueName,
    async (job) => {
      const review = reviewJobSchema.parse(job.data);
      await handler.handle(review.reviewRunId);
    },
    { connection },
  );
}
