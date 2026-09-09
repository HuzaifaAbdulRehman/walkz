import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import {
  registerGitHubAuthRoutes,
  type GitHubAuthApiOptions,
} from './github-auth.js';
import {
  registerInstallationRoutes,
  type InstallationApiOptions,
} from './installation-api.js';
import {
  registerManualReviewRoutes,
  type ManualReviewApiOptions,
} from './manual-review-api.js';
import {
  registerRepositoryRoutes,
  type RepositoryApiOptions,
} from './repository-api.js';
import {
  registerGitHubWebhookRoutes,
  type GitHubWebhookApiOptions,
} from './webhook.js';

export interface HostedApiOptions {
  githubAuth: GitHubAuthApiOptions;
  installations: InstallationApiOptions;
  manualReviews: ManualReviewApiOptions;
  repositories: RepositoryApiOptions;
  webhook: GitHubWebhookApiOptions;
  readiness: {
    check(): Promise<boolean>;
  };
  logger?: boolean;
}

export function createHostedApi(options: HostedApiOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/auth/')) {
      reply.header('cache-control', 'private, no-store');
    }
    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    request.log.error({ err: error }, 'Hosted request failed');
    return reply.code(500).send({ error: 'internal_error' });
  });
  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      if (await options.readiness.check()) return { status: 'ready' };
    } catch {
      // Readiness failures are reported without leaking dependency details.
    }
    return reply.code(503).send({ status: 'not_ready' });
  });
  registerGitHubWebhookRoutes(app, options.webhook);
  registerGitHubAuthRoutes(app, options.githubAuth);
  registerInstallationRoutes(app, options.installations);
  registerManualReviewRoutes(app, options.manualReviews);
  registerRepositoryRoutes(app, options.repositories);
  return app;
}
