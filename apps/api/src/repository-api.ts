import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

const repositoryParamsSchema = z.object({ repositoryId: z.uuid() }).strict();

export interface RepositoryConfigHistoryStore {
  list(repositoryId: string): Promise<readonly unknown[]>;
}

export interface RepositoryApiAuthenticator {
  authenticate(request: unknown): Promise<{ repositoryId: string }>;
}

export interface RepositoryApiOptions {
  configHistory: RepositoryConfigHistoryStore;
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
    return reply.send({ configurations: await options.configHistory.list(repositoryId) });
  });
  return app;
}
