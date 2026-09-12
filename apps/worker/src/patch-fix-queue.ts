import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { z } from 'zod';

export const patchFixQueueName = 'walkz-patch-fixes';

const patchFixJobSchema = z.object({ proposalId: z.uuid() }).strict();

export interface PatchFixQueue {
  add(
    name: string,
    data: { proposalId: string },
    options: {
      jobId: string;
      attempts: number;
      backoff: { type: 'exponential'; delay: number };
      removeOnComplete: true;
      removeOnFail: true;
    },
  ): Promise<unknown>;
}

export interface PatchFixJobHandler {
  handle(proposalId: string): Promise<void>;
}

export async function enqueuePatchFix(
  queue: PatchFixQueue,
  proposalIdInput: unknown,
): Promise<void> {
  const { proposalId } = patchFixJobSchema.parse({ proposalId: proposalIdInput });
  await queue.add('patch-fix', { proposalId }, {
    jobId: proposalId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1_000 },
    removeOnComplete: true,
    removeOnFail: true,
  });
}

export async function recoverPatchFixes(
  queue: PatchFixQueue,
  store: { listRecoverablePatchFixProposalIds(limit: number): Promise<string[]> },
  limit: number,
): Promise<number> {
  const proposalIds = await store.listRecoverablePatchFixProposalIds(limit);
  await Promise.all(proposalIds.map((proposalId) =>
    enqueuePatchFix(queue, proposalId)));
  return proposalIds.length;
}

export function createPatchFixQueue(connection: ConnectionOptions): Queue {
  return new Queue(patchFixQueueName, { connection });
}

export function createPatchFixWorker(
  connection: ConnectionOptions,
  handler: PatchFixJobHandler,
): Worker {
  return new Worker(
    patchFixQueueName,
    async (job) => {
      const fix = patchFixJobSchema.parse(job.data);
      await handler.handle(fix.proposalId);
    },
    { connection },
  );
}
