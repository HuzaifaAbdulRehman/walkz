import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

const repositoryParamsSchema = z.object({ repositoryId: z.uuid() }).strict();

interface DashboardConfiguration {
  id: string;
  schemaVersion: number;
  configHash: string;
  createdAt: string;
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
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    configHash: value.configHash,
    createdAt,
  };
}

export interface RepositoryConfigHistoryStore {
  list(repositoryId: string): Promise<readonly unknown[]>;
}

export interface ReviewHistoryStore {
  list(repositoryId: string): Promise<readonly unknown[]>;
}

export interface RepositoryApiAuthenticator {
  authenticate(request: unknown): Promise<{ repositoryId: string }>;
}

export interface RepositoryApiOptions {
  configHistory: RepositoryConfigHistoryStore;
  reviewHistory: ReviewHistoryStore;
  authenticator: RepositoryApiAuthenticator;
}

export function createRepositoryApi(options: RepositoryApiOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/api/repositories/:repositoryId/configs', async (request, reply) => {
    const { repositoryId } = repositoryParamsSchema.parse(request.params);
    const identity = await options.authenticator.authenticate(request);
    if (identity.repositoryId !== repositoryId) {
      return reply.code(403).send({ error: 'repository_forbidden' });
    }
    const configurations = await options.configHistory.list(repositoryId);
    return reply.send({ configurations: configurations.map(mapDashboardConfiguration) });
  });
  app.get('/api/repositories/:repositoryId/reviews', async (request, reply) => {
    const { repositoryId } = repositoryParamsSchema.parse(request.params);
    const identity = await options.authenticator.authenticate(request);
    if (identity.repositoryId !== repositoryId) {
      return reply.code(403).send({ error: 'repository_forbidden' });
    }
    return reply.send({ reviews: await options.reviewHistory.list(repositoryId) });
  });
  return app;
}
