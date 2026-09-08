import { afterEach, describe, expect, it, vi } from 'vitest';

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
      authenticator: { authenticate: vi.fn().mockResolvedValue({ repositoryId }) },
      configHistory: { list: vi.fn().mockResolvedValue([{ configHash: 'a'.repeat(64) }]) },
      reviewHistory: { list: vi.fn().mockResolvedValue([]) },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/configs` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configurations: [{ configHash: 'a'.repeat(64) }] });
  });

  it('rejects access to another repository', async () => {
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue({ repositoryId: otherRepositoryId }) },
      configHistory: { list: vi.fn() },
      reviewHistory: { list: vi.fn() },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/configs` });

    expect(response.statusCode).toBe(403);
  });

  it('returns review history for an authorized repository', async () => {
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue({ repositoryId }) },
      configHistory: { list: vi.fn().mockResolvedValue([]) },
      reviewHistory: { list: vi.fn().mockResolvedValue([{ status: 'completed' }]) },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/reviews` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reviews: [{ status: 'completed' }] });
  });
});
