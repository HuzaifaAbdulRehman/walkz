import Fastify, { type FastifyInstance } from 'fastify';

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
}

export function createHostedApi(options: HostedApiOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  registerGitHubWebhookRoutes(app, options.webhook);
  registerGitHubAuthRoutes(app, options.githubAuth);
  registerInstallationRoutes(app, options.installations);
  registerManualReviewRoutes(app, options.manualReviews);
  registerRepositoryRoutes(app, options.repositories);
  return app;
}
