import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultWalkzConfig } from '@walkz/contracts';

import { createRepositoryApi } from '../src/index.js';

const repositoryId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const otherRepositoryId = '08d0dd85-734e-4f74-bcfc-3436ec7b4abd';
const apps: Array<ReturnType<typeof createRepositoryApi>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('authenticated repository API', () => {
  it('returns configuration history for an authorized repository', async () => {
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue({ repositoryIds: [repositoryId] }) },
      configHistory: {
        list: vi.fn().mockResolvedValue([{
          id: 'config-1',
          schemaVersion: 1,
          configHash: 'a'.repeat(64),
          createdAt: new Date('2026-09-09T12:00:00.000Z'),
          config: createDefaultWalkzConfig([{
            id: 'typecheck',
            executable: 'npm',
            args: ['run', 'typecheck', 'secret-shaped-value'],
            cwd: '.',
            required: true,
          }]),
        }]),
      },
      reviewHistory: { list: vi.fn().mockResolvedValue([]) },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/configs` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configurations: [{
      id: 'config-1',
      schemaVersion: 1,
      configHash: 'a'.repeat(64),
      createdAt: '2026-09-09T12:00:00.000Z',
      provider: { name: 'groq', model: 'auto' },
      budget: {
        diffBytes: 524_288,
        files: 100,
        tokens: 16_000,
        commandTimeoutMs: 120_000,
        commandOutputBytesPerStream: 262_144,
      },
      triggerPolicy: 'manual',
      blockingEvidenceLevels: ['VERIFIED'],
      commandApprovalPolicy: 'prompt',
      commandCount: 1,
      requiredCommandCount: 1,
      premiumEnabled: false,
      spendingLimitUsd: 0,
    }] });
    expect(response.body).not.toContain('secret-shaped-value');
    expect(response.body).not.toContain('executable');
    expect(response.body).not.toContain('commands');
  });

  it('rejects access to another repository', async () => {
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue({ repositoryIds: [otherRepositoryId] }) },
      configHistory: { list: vi.fn() },
      reviewHistory: { list: vi.fn() },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/configs` });

    expect(response.statusCode).toBe(403);
  });

  it('requires an authenticated session', async () => {
    const list = vi.fn();
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue(null) },
      configHistory: { list },
      reviewHistory: { list },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/configs` });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'authentication_required' });
    expect(list).not.toHaveBeenCalled();
  });

  it('returns review history for an authorized repository', async () => {
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue({ repositoryIds: [repositoryId] }) },
      configHistory: { list: vi.fn().mockResolvedValue([]) },
      reviewHistory: { list: vi.fn().mockResolvedValue([{ status: 'completed' }]) },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/reviews` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reviews: [{ status: 'completed' }] });
  });
});
