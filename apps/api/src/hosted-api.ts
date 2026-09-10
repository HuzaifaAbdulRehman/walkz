import type { Server } from 'node:http';

import Fastify, {
  type FastifyHttpOptions,
  type FastifyInstance,
  type FastifyLoggerOptions,
} from 'fastify';
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
  registerProviderCredentialRoutes,
  type ProviderCredentialApiOptions,
} from './provider-credential-api.js';
import {
  registerRepositoryRoutes,
  type RepositoryApiOptions,
} from './repository-api.js';
import {
  registerGitHubWebhookRoutes,
  type GitHubWebhookApiOptions,
} from './webhook.js';

type HostedLoggerOptions = Exclude<FastifyHttpOptions<Server>['logger'], boolean | undefined>;

export interface HostedApiOptions {
  githubAuth: GitHubAuthApiOptions;
  installations: InstallationApiOptions;
  manualReviews: ManualReviewApiOptions;
  providerCredentials: ProviderCredentialApiOptions;
  repositories: RepositoryApiOptions;
  webhook: GitHubWebhookApiOptions;
  readiness: {
    check(): Promise<boolean>;
  };
  logger?: boolean | HostedLoggerOptions;
}

const querySafeRequestSerializer: NonNullable<
  NonNullable<FastifyLoggerOptions['serializers']>['req']
> =
  (request) => {
    const queryStart = request.url.indexOf('?');
    return {
      method: request.method,
      url: queryStart === -1 ? request.url : request.url.slice(0, queryStart),
      host: request.host,
      remoteAddress: request.ip,
      ...(request.socket.remotePort === undefined
        ? {}
        : { remotePort: request.socket.remotePort }),
    };
  };

function querySafeLogger(
  logger: HostedApiOptions['logger'],
): false | HostedLoggerOptions {
  if (logger === undefined || logger === false) return false;
  const options = logger === true ? {} : logger;
  return {
    ...options,
    serializers: {
      ...options.serializers,
      req: querySafeRequestSerializer,
    },
  };
}

export function createHostedApi(options: HostedApiOptions): FastifyInstance {
  const app = Fastify({ logger: querySafeLogger(options.logger) });
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
  registerProviderCredentialRoutes(app, options.providerCredentials);
  registerRepositoryRoutes(app, options.repositories);
  return app;
}
