import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInstallationApi } from '../src/index.js';

const installationId = '123';
const apps: Array<ReturnType<typeof createInstallationApi>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('installation selection API', () => {
  it('lists repositories across the authenticated installations', async () => {
    const list = vi.fn().mockImplementation(async ({ installationId }: { installationId: string }) => [
      { id: installationId === '123' ? '456' : '789', name: `repo-${installationId}` },
    ]);
    const app = createInstallationApi({
      authenticator: {
        authenticate: vi.fn().mockResolvedValue({
          userId: 'user-1',
          installationIds: ['123', '124'],
        }),
      },
      repositories: { list, select: vi.fn() },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/installations' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      installations: [
        { id: '123', repositories: [{ id: '456', name: 'repo-123' }] },
        { id: '124', repositories: [{ id: '789', name: 'repo-124' }] },
      ],
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('lists and selects repositories within the user installation scope', async () => {
    const list = vi.fn().mockResolvedValue([{ id: '456', name: 'repo' }]);
    const select = vi.fn().mockResolvedValue(undefined);
    const app = createInstallationApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue({ userId: 'user-1', installationIds: [installationId] }) },
      repositories: { list, select },
    });
    apps.push(app);

    const listed = await app.inject({ method: 'GET', url: `/api/installations/${installationId}/repositories` });
    const selected = await app.inject({
      method: 'POST',
      url: `/api/installations/${installationId}/repositories`,
      payload: { repositoryId: '456' },
    });

    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ repositories: [{ id: '456', name: 'repo' }] });
    expect(selected.statusCode).toBe(204);
    expect(list).toHaveBeenCalledWith({ userId: 'user-1', installationId });
    expect(select).toHaveBeenCalledWith({ userId: 'user-1', installationId, repositoryId: '456' });
  });

  it('rejects installations outside the authenticated scope', async () => {
    const list = vi.fn();
    const app = createInstallationApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue({ userId: 'user-1', installationIds: [] }) },
      repositories: { list, select: vi.fn() },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/installations/${installationId}/repositories` });

    expect(response.statusCode).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  it('requires an authenticated session', async () => {
    const list = vi.fn();
    const app = createInstallationApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue(null) },
      repositories: { list, select: vi.fn() },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/installations/${installationId}/repositories`,
    });

    expect(response.statusCode).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it('requires a session before listing installations', async () => {
    const list = vi.fn();
    const app = createInstallationApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue(null) },
      repositories: { list, select: vi.fn() },
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/installations' });

    expect(response.statusCode).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });
});
