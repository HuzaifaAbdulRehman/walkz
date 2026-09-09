import { describe, expect, it, vi } from 'vitest';

import { createPersistentInstallationRepositoryStore } from '../src/index.js';

const userId = '3d963b52-8203-4ba6-bcac-15bf132371f0';

describe('persistent installation repository store', () => {
  it('lists only repositories granted to the exact user', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ githubId: '456', selectedRepositoryId: null }],
    });
    const store = createPersistentInstallationRepositoryStore(
      { query, connect: vi.fn() },
      {
        forInstallation: vi.fn().mockResolvedValue({
          list: vi.fn().mockResolvedValue([
            { githubId: '456', owner: 'owner', name: 'allowed' },
            { githubId: '789', owner: 'owner', name: 'not-granted' },
          ]),
        }),
      },
    );

    await expect(store.list({ userId, installationId: '123' })).resolves.toEqual([{
      id: '456', owner: 'owner', name: 'allowed', selectedRepositoryId: null,
    }]);
  });

  it('rejects selection when GitHub no longer returns the repository', async () => {
    const connect = vi.fn();
    const store = createPersistentInstallationRepositoryStore(
      { query: vi.fn(), connect },
      {
        forInstallation: vi.fn().mockResolvedValue({
          list: vi.fn().mockResolvedValue([]),
        }),
      },
    );

    await expect(store.select({
      userId,
      installationId: '123',
      repositoryId: '456',
    })).rejects.toThrow('Repository access was not found.');
    expect(connect).not.toHaveBeenCalled();
  });
});
