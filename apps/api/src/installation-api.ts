import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

const paramsSchema = z.object({ installationId: z.string().regex(/^[1-9][0-9]{0,18}$/) }).strict();
const selectionSchema = z.object({ repositoryId: z.string().regex(/^[1-9][0-9]{0,18}$/) }).strict();

export interface InstallationRepositoryStore {
  list(input: { userId: string; installationId: string }): Promise<readonly unknown[]>;
  select(input: {
    userId: string;
    installationId: string;
    repositoryId: string;
  }): Promise<void>;
}

export interface InstallationAuthenticator {
  authenticate(request: unknown): Promise<{
    userId: string;
    installationIds: readonly string[];
  } | null>;
}

export interface InstallationApiOptions {
  authenticator: InstallationAuthenticator;
  repositories: InstallationRepositoryStore;
}

export function registerInstallationRoutes(
  app: FastifyInstance,
  options: InstallationApiOptions,
): void {
  app.get('/api/installations/:installationId/repositories', async (request, reply) => {
    const { installationId } = paramsSchema.parse(request.params);
    const identity = await options.authenticator.authenticate(request);
    if (identity === null) return reply.code(401).send({ error: 'authentication_required' });
    if (!identity.installationIds.includes(installationId)) {
      return reply.code(403).send({ error: 'installation_forbidden' });
    }
    return reply.send({
      repositories: await options.repositories.list({
        userId: identity.userId,
        installationId,
      }),
    });
  });
  app.post('/api/installations/:installationId/repositories', async (request, reply) => {
    const { installationId } = paramsSchema.parse(request.params);
    const { repositoryId } = selectionSchema.parse(request.body);
    const identity = await options.authenticator.authenticate(request);
    if (identity === null) return reply.code(401).send({ error: 'authentication_required' });
    if (!identity.installationIds.includes(installationId)) {
      return reply.code(403).send({ error: 'installation_forbidden' });
    }
    await options.repositories.select({
      userId: identity.userId,
      installationId,
      repositoryId,
    });
    return reply.code(204).send();
  });
}

export function createInstallationApi(options: InstallationApiOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  registerInstallationRoutes(app, options);
  return app;
}
