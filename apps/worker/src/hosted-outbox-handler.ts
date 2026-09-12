import {
  patchFixQueuedOutboxEventSchema,
  reviewRunQueuedOutboxEventSchema,
  type ClaimedOutboxEvent,
} from '@walkz/persistence';

import type { OutboxEventHandler } from './index.js';
import { enqueuePatchFix, type PatchFixQueue } from './patch-fix-queue.js';
import { enqueueReviewRun, type ReviewQueue } from './review-queue.js';

export interface CheckOutboxHandler {
  handle(
    event: ClaimedOutboxEvent,
    input: { idempotencyKey: string },
  ): Promise<void>;
}

export function createHostedOutboxHandler(options: {
  checks: CheckOutboxHandler;
  patchFixes: PatchFixQueue;
  reviews: ReviewQueue;
}): OutboxEventHandler {
  return {
    async handle(event, input) {
      if (input.idempotencyKey !== event.id) {
        throw new Error('Outbox handler idempotency key must match the event ID.');
      }
      if (event.eventType === 'review_run.queued') {
        const queued = reviewRunQueuedOutboxEventSchema.parse({
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          payload: event.payload,
        });
        await enqueueReviewRun(options.reviews, queued.payload.reviewRunId);
        return;
      }
      if (event.eventType === 'patch_fix.queued') {
        const queued = patchFixQueuedOutboxEventSchema.parse({
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          payload: event.payload,
        });
        await enqueuePatchFix(options.patchFixes, queued.payload.proposalId);
        return;
      }
      if (
        event.eventType === 'github_check.queued' ||
        event.eventType === 'github_check.completed'
      ) {
        await options.checks.handle(event, input);
        return;
      }
      throw new Error('Unsupported outbox event type.');
    },
  };
}
