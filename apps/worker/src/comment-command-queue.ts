import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { z } from 'zod';

export const commentCommandQueueName = 'walkz-comment-commands';

const commentCommandJobSchema = z.object({ commandId: z.uuid() }).strict();

export interface CommentCommandQueue {
  add(
    name: string,
    data: { commandId: string },
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: 'exponential'; delay: number };
      removeOnComplete: true;
      removeOnFail: true;
    },
  ): Promise<unknown>;
}

export interface CommentCommandJobHandler {
  handle(commandId: string): Promise<void>;
}

export async function enqueueCommentCommand(
  queue: CommentCommandQueue,
  commandIdInput: unknown,
): Promise<void> {
  const { commandId } = commentCommandJobSchema.parse({ commandId: commandIdInput });
  await queue.add('comment-command', { commandId }, {
    jobId: commandId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}

export async function recoverCommentCommands(
  queue: CommentCommandQueue,
  store: { listRecoverableReviewCommentCommandIds(limit: number): Promise<string[]> },
  limit: number,
): Promise<number> {
  const commandIds = await store.listRecoverableReviewCommentCommandIds(limit);
  await Promise.all(commandIds.map((commandId) =>
    enqueueCommentCommand(queue, commandId)));
  return commandIds.length;
}

export function createCommentCommandQueue(connection: ConnectionOptions): Queue {
  return new Queue(commentCommandQueueName, { connection });
}

export function createCommentCommandWorker(
  connection: ConnectionOptions,
  handler: CommentCommandJobHandler,
): Worker {
  return new Worker(
    commentCommandQueueName,
    async (job) => {
      const command = commentCommandJobSchema.parse(job.data);
      await handler.handle(command.commandId);
    },
    { connection },
  );
}
