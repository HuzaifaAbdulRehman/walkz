import type { Server } from 'node:http';

import Fastify, {
  LogController,
  type FastifyHttpOptions,
  type FastifyInstance,
  type FastifyLoggerOptions,
} from 'fastify';
import type { DurableOperationalTelemetry } from '@walkz/persistence';
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
import { registerPatchFixRoutes, type PatchFixApiOptions } from './patch-fix-api.js';
import {
  registerPatchSuggestionRoutes,
  type PatchSuggestionApiOptions,
} from './patch-suggestion-api.js';
import {
  registerRepositoryRoutes,
  type RepositoryApiOptions,
} from './repository-api.js';
import {
  registerGitHubWebhookRoutes,
  type GitHubWebhookApiOptions,
} from './webhook.js';
import { createHttpOperationalTelemetry } from './operational-telemetry.js';

type HostedLoggerOptions = Exclude<FastifyHttpOptions<Server>['logger'], boolean | undefined>;

export interface HostedApiOptions {
  githubAuth: GitHubAuthApiOptions;
  installations: InstallationApiOptions;
  manualReviews: ManualReviewApiOptions;
  providerCredentials: ProviderCredentialApiOptions;
  patchFixes: PatchFixApiOptions;
  patchSuggestions: PatchSuggestionApiOptions;
  repositories: RepositoryApiOptions;
  webhook: GitHubWebhookApiOptions;
  readiness: {
    check(): Promise<boolean>;
  };
  telemetry: {
    load(): Promise<DurableOperationalTelemetry>;
    timeoutMs?: number;
  };
  logger?: boolean | HostedLoggerOptions;
}

const querySafeRequestSerializer: NonNullable<
  NonNullable<FastifyLoggerOptions['serializers']>['req']
> =
  (request) => {
    return {
      method: normalizeMethod(request.method),
    };
  };

const loggedMethods = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
]);

function normalizeMethod(method: string): string {
  return loggedMethods.has(method) ? method : 'OTHER';
}

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
      err: () => ({
        type: 'Error',
        message: 'redacted',
        stack: '',
      }),
    },
  };
}

export function createHostedApi(options: HostedApiOptions): FastifyInstance {
  const telemetry = createHttpOperationalTelemetry();
  let postgresOperationalState: 'up' | 'down' | undefined;
  const telemetryTimeoutMs = Math.max(1, Math.min(
    5_000,
    options.telemetry.timeoutMs ?? 1_500,
  ));
  let durableLoad: Promise<DurableOperationalTelemetry> | undefined;
  const loadDurable = (): Promise<DurableOperationalTelemetry> => {
    durableLoad ??= options.telemetry.load().finally(() => {
      durableLoad = undefined;
    });
    return durableLoad;
  };
  const loadDurableWithinDeadline = (): Promise<DurableOperationalTelemetry> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Operational telemetry deadline reached.')),
        telemetryTimeoutMs,
      );
      timer.unref();
      void loadDurable().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: querySafeLogger(options.logger),
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      request.url.startsWith('/api/') ||
      request.url.startsWith('/auth/') ||
      request.url.startsWith('/ops/')
    ) {
      reply.header('cache-control', 'private, no-store');
    }
    return payload;
  });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    if (route.startsWith('/health/') || route.startsWith('/ops/')) return;
    telemetry.observe(reply.statusCode, reply.elapsedTime);
    request.log.info({
      event: 'http_request_completed',
      route,
      method: normalizeMethod(request.method),
      statusCode: reply.statusCode,
      durationMs: Math.max(0, Math.round(reply.elapsedTime)),
    }, 'Hosted request completed');
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
  app.get('/ops/telemetry', async (request, reply) => {
    const startedAt = Date.now();
    try {
      const durable = await loadDurableWithinDeadline();
      if (postgresOperationalState === 'down') {
        request.log.info({
          event: 'dependency_recovered',
          dependency: 'postgres',
        }, 'Operational dependency recovered');
      }
      postgresOperationalState = 'up';
      return {
        schemaVersion: 1,
        service: 'api',
        generatedAt: new Date().toISOString(),
        dependencies: {
          postgres: { status: 'up', latencyMs: Date.now() - startedAt },
        },
        process: telemetry.snapshot(),
        durable,
      };
    } catch {
      if (postgresOperationalState !== 'down') {
        request.log.warn({
          event: 'dependency_check_failed',
          dependency: 'postgres',
        }, 'Operational dependency check failed');
      }
      postgresOperationalState = 'down';
      return reply.code(503).send({
        schemaVersion: 1,
        service: 'api',
        generatedAt: new Date().toISOString(),
        dependencies: {
          postgres: { status: 'down', latencyMs: Date.now() - startedAt },
        },
        process: telemetry.snapshot(),
        durable: null,
      });
    }
  });
  registerGitHubWebhookRoutes(app, options.webhook);
  registerGitHubAuthRoutes(app, options.githubAuth);
  registerInstallationRoutes(app, options.installations);
  registerManualReviewRoutes(app, options.manualReviews);
  registerProviderCredentialRoutes(app, options.providerCredentials);
  registerPatchFixRoutes(app, options.patchFixes);
  registerPatchSuggestionRoutes(app, options.patchSuggestions);
  registerRepositoryRoutes(app, options.repositories);
  return app;
}
