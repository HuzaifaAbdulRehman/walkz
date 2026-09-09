import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { z } from 'zod';

export const reviewQueueName = 'walkz-reviews';

const reviewJobSchema = z.object({ reviewRunId: z.uuid() }).strict();

export interface ReviewQueue {
  add(
    name: string,
    data: { reviewRunId: string },
    options: { jobId: string },
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
  await queue.add('review', { reviewRunId }, { jobId: reviewRunId });
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
