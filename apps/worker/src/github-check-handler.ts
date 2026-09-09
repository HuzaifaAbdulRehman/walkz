import {
  parseReviewCheckPayload,
  type ReviewCheckPublisher,
} from '@walkz/github';
import {
  githubCheckQueuedOutboxEventSchema,
  type ClaimedOutboxEvent,
} from '@walkz/persistence';

export interface InstallationReviewCheckPublisherFactory {
  forInstallation(installationId: string): Promise<ReviewCheckPublisher>;
}

export function createGitHubCheckOutboxHandler(
  factory: InstallationReviewCheckPublisherFactory,
) {
  return {
    async handle(
      event: ClaimedOutboxEvent,
      input: { idempotencyKey: string },
    ): Promise<void> {
      if (input.idempotencyKey !== event.id) {
        throw new Error('Outbox handler idempotency key must match the event ID.');
      }
      const queued = githubCheckQueuedOutboxEventSchema.parse({
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        payload: event.payload,
      });
      const check = parseReviewCheckPayload({
        name: 'Walkz / review',
        baseSha: queued.payload.baseSha,
        headSha: queued.payload.headSha,
        status: 'queued',
        conclusion: null,
        summary: 'Walkz accepted this review and queued analysis for the exact pull request head.',
        annotations: [],
      });
      const publisher = await factory.forInstallation(queued.payload.installationId);
      await publisher.publish(
        { owner: queued.payload.owner, repository: queued.payload.repository },
        check,
        queued.payload.reviewRunId,
      );
    },
  };
}
