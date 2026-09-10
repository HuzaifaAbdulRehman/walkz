import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  deleteProviderCredential,
  hasProviderCredential,
  recordAuditEvent,
  storeProviderCredential,
  withTransaction,
  type CredentialVault,
} from '@walkz/persistence';

const repositoryParamsSchema = z.object({ repositoryId: z.uuid() }).strict();
const credentialBodySchema = z.object({
  apiKey: z.string().min(1).max(1_024),
}).strict();

const provider = 'groq' as const;

export interface ProviderCredentialAuthenticator {
  authenticate(request: unknown): Promise<{
    userId: string;
    repositoryIds: readonly string[];
  } | null>;
}

export interface ProviderCredentialStore {
  has(repositoryId: string): Promise<boolean>;
  save(input: {
    actorUserId: string;
    repositoryId: string;
    apiKey: string;
  }): Promise<void>;
  delete(input: {
    actorUserId: string;
    repositoryId: string;
  }): Promise<void>;
}

export type ProviderCredentialValidation =
  | { valid: true; selectedModel: string }
  | { valid: false; reason: 'rejected' | 'unavailable' };

export interface ProviderCredentialValidator {
  validate(apiKey: string): Promise<ProviderCredentialValidation>;
}

export interface ProviderCredentialApiOptions {
  authenticator: ProviderCredentialAuthenticator;
  credentials: ProviderCredentialStore;
  validator: ProviderCredentialValidator;
}

type ProviderCredentialPool =
  Parameters<typeof hasProviderCredential>[0] &
  Parameters<typeof withTransaction>[0];

export function createPersistentProviderCredentialStore(
  pool: ProviderCredentialPool,
  vault: CredentialVault,
): ProviderCredentialStore {
  return {
    has: (repositoryId) => hasProviderCredential(pool, { repositoryId, provider }),
    async save(input) {
      await withTransaction(pool, async (client) => {
        await storeProviderCredential(client, vault, {
          repositoryId: input.repositoryId,
          provider,
          credential: input.apiKey,
        });
        await recordAuditEvent(client, {
          actorUserId: input.actorUserId,
          eventType: 'provider_credential.stored',
          summary: 'Stored a repository provider credential.',
          metadata: {
            operation: 'provider_credential.store',
            outcome: 'completed',
            subjectId: input.repositoryId,
          },
        });
      });
    },
    async delete(input) {
      await withTransaction(pool, async (client) => {
        await deleteProviderCredential(client, {
          repositoryId: input.repositoryId,
          provider,
        });
        await recordAuditEvent(client, {
          actorUserId: input.actorUserId,
          eventType: 'provider_credential.deleted',
          summary: 'Removed a repository provider credential.',
          metadata: {
            operation: 'provider_credential.delete',
            outcome: 'completed',
            subjectId: input.repositoryId,
          },
        });
      });
    },
  };
}

async function authorize(
  request: unknown,
  repositoryId: string,
  options: ProviderCredentialApiOptions,
): Promise<
  | { authorized: true; userId: string }
  | { authorized: false; status: 401 | 403; error: string }
> {
  const identity = await options.authenticator.authenticate(request);
  if (identity === null) {
    return { authorized: false, status: 401, error: 'authentication_required' };
  }
  if (!identity.repositoryIds.includes(repositoryId)) {
    return { authorized: false, status: 403, error: 'repository_forbidden' };
  }
  return { authorized: true, userId: identity.userId };
}

export function registerProviderCredentialRoutes(
  app: FastifyInstance,
  options: ProviderCredentialApiOptions,
): void {
  const path = '/api/repositories/:repositoryId/provider-credentials/groq';

  app.get(path, async (request, reply) => {
    const { repositoryId } = repositoryParamsSchema.parse(request.params);
    const access = await authorize(request, repositoryId, options);
    if (!access.authorized) {
      return reply.code(access.status).send({ error: access.error });
    }
    return reply.send({ provider, connected: await options.credentials.has(repositoryId) });
  });

  app.put(path, async (request, reply) => {
    const { repositoryId } = repositoryParamsSchema.parse(request.params);
    const access = await authorize(request, repositoryId, options);
    if (!access.authorized) {
      return reply.code(access.status).send({ error: access.error });
    }
    const credentialBody = credentialBodySchema.safeParse(request.body);
    if (!credentialBody.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const { apiKey } = credentialBody.data;
    const validation = await options.validator.validate(apiKey);
    if (!validation.valid) {
      const unavailable = validation.reason === 'unavailable';
      return reply.code(unavailable ? 503 : 400).send({
        error: unavailable
          ? 'provider_verification_unavailable'
          : 'provider_credential_rejected',
      });
    }
    await options.credentials.save({
      actorUserId: access.userId,
      repositoryId,
      apiKey,
    });
    return reply.send({
      provider,
      connected: true,
      selectedModel: validation.selectedModel,
    });
  });

  app.delete(path, async (request, reply) => {
    const { repositoryId } = repositoryParamsSchema.parse(request.params);
    const access = await authorize(request, repositoryId, options);
    if (!access.authorized) {
      return reply.code(access.status).send({ error: access.error });
    }
    await options.credentials.delete({
      actorUserId: access.userId,
      repositoryId,
    });
    return reply.code(204).send();
  });
}

export function createProviderCredentialApi(
  options: ProviderCredentialApiOptions,
): FastifyInstance {
  const app = Fastify({ logger: false });
  registerProviderCredentialRoutes(app, options);
  return app;
}
