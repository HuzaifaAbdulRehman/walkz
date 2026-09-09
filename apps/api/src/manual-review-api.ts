import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { InstallationPullRequestReaderFactory } from '@walkz/github';
import {
  getManualReviewRepository,
  queueManualReview,
  type ManualReviewInput,
  type ManualReviewRepository,
} from '@walkz/persistence';

const paramsSchema = z.object({
  repositoryId: z.uuid(),
  pullRequestNumber: z.coerce.number().int().positive(),
}).strict();
const idempotencyKeySchema = z.uuid();

export interface ManualReviewAuthenticator {
  authenticate(request: unknown): Promise<{ repositoryIds: readonly string[] } | null>;
}

export interface ManualReviewStarter {
  start(input: {
    requestId: string;
    repositoryId: string;
    pullRequestNumber: number;
  }): Promise<{ reviewRunId: string }>;
}

export interface ManualReviewApiOptions {
  authenticator: ManualReviewAuthenticator;
  reviews: ManualReviewStarter;
}

type ManualReviewPool =
  Parameters<typeof getManualReviewRepository>[0] &
  Parameters<typeof queueManualReview>[0];

export interface ManualReviewServiceOptions {
  repositories: {
    get(repositoryId: string): Promise<ManualReviewRepository | null>;
  };
  pullRequests: InstallationPullRequestReaderFactory;
  queue: {
    enqueue(input: ManualReviewInput): Promise<{ reviewRunId: string }>;
  };
  promptVersion: string;
}

export function createManualReviewStarter(
  options: ManualReviewServiceOptions,
): ManualReviewStarter {
  const version = z.string().trim().min(1).max(128).parse(options.promptVersion);
  return {
    async start(input) {
      const repository = await options.repositories.get(input.repositoryId);
      if (repository === null) {
        throw new Error('Selected repository is not configured.');
      }
      const reader = await options.pullRequests.forInstallation(repository.installationId);
      const pullRequest = await reader.get(
        { owner: repository.owner, repository: repository.repository },
        input.pullRequestNumber,
      );
      if (
        pullRequest.number !== input.pullRequestNumber ||
        pullRequest.repositoryGitHubId !== repository.githubId
      ) {
        throw new Error('GitHub pull request does not match the selected repository.');
      }
      const queued = await options.queue.enqueue({
        requestId: input.requestId,
        repositoryId: repository.repositoryId,
        installationId: repository.installationId,
        githubId: repository.githubId,
        owner: pullRequest.repositoryOwner,
        repository: pullRequest.repositoryName,
        pullRequestId: pullRequest.githubId,
        pullRequestNumber: pullRequest.number,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
        promptVersion: version,
      });
      return { reviewRunId: queued.reviewRunId };
    },
  };
}

export function createPersistentManualReviewStarter(
  pool: ManualReviewPool,
  pullRequests: InstallationPullRequestReaderFactory,
  promptVersion: string,
): ManualReviewStarter {
  return createManualReviewStarter({
    repositories: {
      get: (repositoryId) => getManualReviewRepository(pool, repositoryId),
    },
    pullRequests,
    queue: {
      enqueue: (input) => queueManualReview(pool, input),
    },
    promptVersion,
  });
}

export function createManualReviewApi(
  options: ManualReviewApiOptions,
): FastifyInstance {
  const app = Fastify({ logger: false });
  registerManualReviewRoutes(app, options);
  return app;
}

export function registerManualReviewRoutes(
  app: FastifyInstance,
  options: ManualReviewApiOptions,
): void {
  app.post(
    '/api/repositories/:repositoryId/pull-requests/:pullRequestNumber/reviews',
    async (request, reply) => {
      const params = paramsSchema.parse(request.params);
      const identity = await options.authenticator.authenticate(request);
      if (identity === null) return reply.code(401).send({ error: 'authentication_required' });
      if (!identity.repositoryIds.includes(params.repositoryId)) {
        return reply.code(403).send({ error: 'repository_forbidden' });
      }
      const idempotencyKey = idempotencyKeySchema.safeParse(
        request.headers['idempotency-key'],
      );
      if (!idempotencyKey.success) {
        return reply.code(400).send({ error: 'invalid_idempotency_key' });
      }
      const review = await options.reviews.start({
        ...params,
        requestId: idempotencyKey.data,
      });
      return reply.code(202).send(review);
    },
  );
}
