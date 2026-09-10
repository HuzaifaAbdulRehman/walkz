import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCredentialVault } from '@walkz/persistence';

import {
  createPersistentProviderCredentialStore,
  createProviderCredentialApi,
} from '../src/index.js';

const repositoryId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const otherRepositoryId = '08d0dd85-734e-4f74-bcfc-3436ec7b4abd';
const userId = 'db0af86d-fd29-459b-b680-817d20447d6f';
const apiKey = 'gsk_test-secret-value';
const apps: Array<ReturnType<typeof createProviderCredentialApi>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function options(overrides: Record<string, unknown> = {}) {
  return {
    authenticator: {
      authenticate: vi.fn().mockResolvedValue({ userId, repositoryIds: [repositoryId] }),
    },
    credentials: {
      has: vi.fn().mockResolvedValue(false),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    validator: {
      validate: vi.fn().mockResolvedValue({
        valid: true as const,
        selectedModel: 'openai/gpt-oss-20b',
      }),
    },
    ...overrides,
  };
}

describe('repository provider credentials', () => {
  it('returns only whether Groq is connected', async () => {
    const setup = options();
    setup.credentials.has.mockResolvedValue(true);
    const app = createProviderCredentialApi(setup);
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repositoryId}/provider-credentials/groq`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ provider: 'groq', connected: true });
    expect(response.body).not.toContain('gsk_');
  });

  it('validates before storing a replacement key', async () => {
    const setup = options();
    const app = createProviderCredentialApi(setup);
    apps.push(app);

    const response = await app.inject({
      method: 'PUT',
      url: `/api/repositories/${repositoryId}/provider-credentials/groq`,
      payload: { apiKey },
    });

    expect(response.statusCode).toBe(200);
    expect(setup.validator.validate).toHaveBeenCalledWith(apiKey);
    expect(setup.credentials.save).toHaveBeenCalledWith({
      actorUserId: userId,
      repositoryId,
      apiKey,
    });
    expect(response.json()).toEqual({
      provider: 'groq',
      connected: true,
      selectedModel: 'openai/gpt-oss-20b',
    });
    expect(response.body).not.toContain(apiKey);
  });

  it('does not store a rejected or unverifiable key', async () => {
    for (const [reason, status, error] of [
      ['rejected', 400, 'provider_credential_rejected'],
      ['unavailable', 503, 'provider_verification_unavailable'],
    ] as const) {
      const setup = options({
        validator: { validate: vi.fn().mockResolvedValue({ valid: false, reason }) },
      });
      const app = createProviderCredentialApi(setup);
      apps.push(app);
      const response = await app.inject({
        method: 'PUT',
        url: `/api/repositories/${repositoryId}/provider-credentials/groq`,
        payload: { apiKey },
      });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error });
      expect(setup.credentials.save).not.toHaveBeenCalled();
      expect(response.body).not.toContain(apiKey);
    }
  });

  it('rejects malformed credentials before validation', async () => {
    const setup = options();
    const app = createProviderCredentialApi(setup);
    apps.push(app);

    const empty = await app.inject({
      method: 'PUT',
      url: `/api/repositories/${repositoryId}/provider-credentials/groq`,
      payload: { apiKey: '' },
    });
    const oversized = await app.inject({
      method: 'PUT',
      url: `/api/repositories/${repositoryId}/provider-credentials/groq`,
      payload: { apiKey: 'x'.repeat(1_025) },
    });

    expect(empty.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(400);
    expect(setup.validator.validate).not.toHaveBeenCalled();
    expect(setup.credentials.save).not.toHaveBeenCalled();
  });

  it('requires authentication and repository authorization', async () => {
    for (const [principal, expectedStatus] of [
      [null, 401],
      [{ userId, repositoryIds: [otherRepositoryId] }, 403],
    ] as const) {
      const setup = options({
        authenticator: { authenticate: vi.fn().mockResolvedValue(principal) },
      });
      const app = createProviderCredentialApi(setup);
      apps.push(app);
      const response = await app.inject({
        method: 'PUT',
        url: `/api/repositories/${repositoryId}/provider-credentials/groq`,
        payload: { apiKey },
      });

      expect(response.statusCode).toBe(expectedStatus);
      expect(setup.validator.validate).not.toHaveBeenCalled();
      expect(setup.credentials.save).not.toHaveBeenCalled();
    }
  });

  it('removes a credential without revealing whether one existed', async () => {
    const setup = options();
    const app = createProviderCredentialApi(setup);
    apps.push(app);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/repositories/${repositoryId}/provider-credentials/groq`,
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(setup.credentials.delete).toHaveBeenCalledWith({
      actorUserId: userId,
      repositoryId,
    });
  });
});

describe('persistent provider credential store', () => {
  it('encrypts the key and audits replacement in one transaction', async () => {
    const query = vi.fn(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('INSERT INTO provider_credentials')) {
        return { rows: [{ id: 'credential-id' }] };
      }
      if (sql.includes('INSERT INTO audit_events')) {
        return { rows: [{ id: 'audit-id' }] };
      }
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }), query } as unknown as
      Parameters<typeof createPersistentProviderCredentialStore>[0];
    const vault = createCredentialVault({
      activeKeyId: 'primary-2026',
      keys: { 'primary-2026': Buffer.alloc(32, 7).toString('base64') },
    });
    const store = createPersistentProviderCredentialStore(pool, vault);

    await store.save({ actorUserId: userId, repositoryId, apiKey });

    expect(query.mock.calls.map(([sql]) => String(sql).trim())).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO provider_credentials'),
      expect.stringContaining('INSERT INTO audit_events'),
      'COMMIT',
    ]);
    expect(query.mock.calls.flat().join('')).not.toContain(apiKey);
    const credentialValues = query.mock.calls[1]?.[1] as unknown[] | undefined;
    expect(credentialValues?.[3]).toBeInstanceOf(Buffer);
    expect((credentialValues?.[3] as Buffer | undefined)?.includes(apiKey)).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back when audit storage fails', async () => {
    const query = vi.fn(async (...args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('INSERT INTO provider_credentials')) {
        return { rows: [{ id: 'credential-id' }] };
      }
      if (sql.includes('INSERT INTO audit_events')) throw new Error('audit unavailable');
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }), query } as unknown as
      Parameters<typeof createPersistentProviderCredentialStore>[0];
    const vault = createCredentialVault({
      activeKeyId: 'primary-2026',
      keys: { 'primary-2026': Buffer.alloc(32, 7).toString('base64') },
    });
    const store = createPersistentProviderCredentialStore(pool, vault);

    await expect(store.save({ actorUserId: userId, repositoryId, apiKey }))
      .rejects.toThrow('audit unavailable');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
