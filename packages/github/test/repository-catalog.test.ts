import { describe, expect, it, vi } from 'vitest';

import { createInstallationRepositoryCatalogFactory } from '../src/index.js';

describe('installation repository catalog', () => {
  it('lists repositories through installation credentials', async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        repositories: [{
          id: 456,
          name: 'walkz',
          private: true,
          html_url: 'https://github.com/HuzaifaAbdulRehman/walkz',
          owner: {
            id: 123,
            login: 'HuzaifaAbdulRehman',
            avatar_url: 'https://avatars.githubusercontent.com/u/123',
          },
        }],
      },
    });
    const factory = createInstallationRepositoryCatalogFactory({
      getInstallationOctokit: vi.fn().mockResolvedValue({ request }),
    });

    const catalog = await factory.forInstallation('123');

    await expect(catalog.list()).resolves.toEqual([{
      githubId: '456', owner: 'HuzaifaAbdulRehman', name: 'walkz',
    }]);
    expect(request).toHaveBeenCalledWith('GET /installation/repositories', {
      per_page: 100,
      page: 1,
    });
  });

  it('rejects malformed repository data', async () => {
    const factory = createInstallationRepositoryCatalogFactory({
      getInstallationOctokit: vi.fn().mockResolvedValue({
        request: vi.fn().mockResolvedValue({ data: { repositories: [{ id: 0 }] } }),
      }),
    });

    const catalog = await factory.forInstallation('123');

    await expect(catalog.list()).rejects.toThrow();
  });
});
