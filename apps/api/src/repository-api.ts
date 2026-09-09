import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { repositoryConfigSchema } from '@walkz/contracts';

const repositoryParamsSchema = z.object({ repositoryId: z.uuid() }).strict();

interface DashboardConfiguration {
  id: string;
  schemaVersion: number;
  configHash: string;
  createdAt: string;
  provider: {
    name: 'groq';
    model: string;
  };
  budget: {
    diffBytes: number;
    files: number;
    tokens: number;
    commandTimeoutMs: number;
    commandOutputBytesPerStream: number;
  };
  triggerPolicy: 'manual' | 'ready_for_review' | 'every_push';
  blockingEvidenceLevels: Array<'VERIFIED' | 'SUPPORTED'>;
  commandApprovalPolicy: 'prompt' | 'trusted_config';
  commandCount: number;
  requiredCommandCount: number;
  premiumEnabled: false;
  spendingLimitUsd: 0;
}

function mapDashboardConfiguration(input: unknown): DashboardConfiguration {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Stored configuration history was invalid.');
  }
  const value = input as Record<string, unknown>;
  const createdAt = value.createdAt instanceof Date
    ? value.createdAt.toISOString()
    : value.createdAt;
  if (
    typeof value.id !== 'string' ||
    typeof value.schemaVersion !== 'number' ||
    !Number.isInteger(value.schemaVersion) ||
    typeof value.configHash !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    throw new Error('Stored configuration history was invalid.');
  }
  const config = repositoryConfigSchema.safeParse(value.config);
  if (!config.success) {
    throw new Error('Stored configuration history was invalid.');
  }
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    configHash: value.configHash,
    createdAt,
    provider: config.data.provider,
    budget: {
      diffBytes: config.data.diffBudgetBytes,
      files: config.data.fileBudget,
      tokens: config.data.tokenBudget,
      commandTimeoutMs: config.data.commandTimeoutMs,
      commandOutputBytesPerStream: config.data.commandOutputBytesPerStream,
    },
    triggerPolicy: config.data.triggerPolicy,
    blockingEvidenceLevels: config.data.blockingEvidenceLevels,
    commandApprovalPolicy: config.data.commandApprovalPolicy,
    commandCount: config.data.commands.length,
    requiredCommandCount: config.data.commands.filter((command) => command.required).length,
    premiumEnabled: config.data.premiumEnabled,
    spendingLimitUsd: config.data.spendingLimitUsd,
  };
}

export interface RepositoryConfigHistoryStore {
  list(repositoryId: string): Promise<readonly unknown[]>;
}

export interface ReviewHistoryStore {
  list(repositoryId: string): Promise<readonly unknown[]>;
}

export interface RepositoryApiAuthenticator {
  authenticate(request: unknown): Promise<{ repositoryIds: readonly string[] } | null>;
}

export interface RepositoryApiOptions {
  configHistory: RepositoryConfigHistoryStore;
  reviewHistory: ReviewHistoryStore;
  authenticator: RepositoryApiAuthenticator;
}

export function registerRepositoryRoutes(
  app: FastifyInstance,
  options: RepositoryApiOptions,
): void {
  app.get('/api/repositories/:repositoryId/configs', async (request, reply) => {
    const { repositoryId } = repositoryParamsSchema.parse(request.params);
    const identity = await options.authenticator.authenticate(request);
    if (identity === null) return reply.code(401).send({ error: 'authentication_required' });
    if (!identity.repositoryIds.includes(repositoryId)) {
      return reply.code(403).send({ error: 'repository_forbidden' });
    }
    const configurations = await options.configHistory.list(repositoryId);
    return reply.send({ configurations: configurations.map(mapDashboardConfiguration) });
  });
  app.get('/api/repositories/:repositoryId/reviews', async (request, reply) => {
    const { repositoryId } = repositoryParamsSchema.parse(request.params);
    const identity = await options.authenticator.authenticate(request);
    if (identity === null) return reply.code(401).send({ error: 'authentication_required' });
    if (!identity.repositoryIds.includes(repositoryId)) {
      return reply.code(403).send({ error: 'repository_forbidden' });
    }
    return reply.send({ reviews: await options.reviewHistory.list(repositoryId) });
  });
}

export function createRepositoryApi(options: RepositoryApiOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRepositoryRoutes(app, options);
  return app;
}
