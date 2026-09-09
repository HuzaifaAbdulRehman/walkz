import { describe, expect, it, vi } from 'vitest';

import { createDefaultWalkzConfig } from '@walkz/contracts';

import { listGrantedRepositories, selectGrantedRepository } from '../src/index.js';

const userId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const repositoryId = '08d0dd85-734e-4f74-bcfc-3436ec7b4abd';
const installationUuid = 'df804b45-6b8e-4bc0-ab8a-f0724f27cb2c';

describe('repository selection', () => {
  it('lists grants for the exact user and installation', async () => {
    const rows = [{ githubId: '456', selectedRepositoryId: repositoryId }];
    const query = vi.fn().mockResolvedValue({ rows });

    await expect(listGrantedRepositories({ query }, {
      userId,
      installationId: '123',
    })).resolves.toEqual(rows);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ui.user_id = $1'), [userId, '123']);
  });

  it('stores a granted repository with an immutable default config', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ installationId: installationUuid }] })
      .mockResolvedValueOnce({ rows: [{ repositoryId }] })
      .mockResolvedValueOnce({ rows: [{ id: 'config-id' }] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn().mockResolvedValue(client) };

    await expect(selectGrantedRepository(pool, {
      userId,
      installationId: '123',
      repository: { githubId: '456', owner: 'owner', name: 'walkz' },
      config: createDefaultWalkzConfig(),
    })).resolves.toEqual({ repositoryId, configCreated: true });
    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('ura.user_id = ui.user_id'),
      [userId, '123', '456'],
    );
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('rejects a repository outside the exact user grant', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const client = { query, release: vi.fn() };

    await expect(selectGrantedRepository(
      { connect: vi.fn().mockResolvedValue(client) },
      {
        userId,
        installationId: '123',
        repository: { githubId: '456', owner: 'owner', name: 'walkz' },
        config: createDefaultWalkzConfig(),
      },
    )).rejects.toThrow('Repository access was not found.');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
  });
});
