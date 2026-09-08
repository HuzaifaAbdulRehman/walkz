import { describe, expect, it, vi } from 'vitest';

import { createGitHubReadClient } from '../src/index.js';

function response(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

describe('GitHub read client', () => {
  it('reads installation identity and selected repositories', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ id: 123, account: { login: 'owner' } }))
      .mockResolvedValueOnce(response({ repositories: [{ id: 456, name: 'repo', owner: { login: 'owner' } }] }));
    const client = createGitHubReadClient('token', fetcher);

    await expect(client.getInstallation('123')).resolves.toEqual({ id: '123', accountLogin: 'owner' });
    await expect(client.listInstallationRepositories('123')).resolves.toEqual([
      { id: '456', owner: 'owner', name: 'repo' },
    ]);
    expect(fetcher).toHaveBeenNthCalledWith(1, 'https://api.github.com/app/installations/123', expect.anything());
  });

  it('does not leak tokens and surfaces non-success responses', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({}, false, 403));
    const client = createGitHubReadClient('secret-token', fetcher);

    await expect(client.getInstallation('123')).rejects.toThrow('status 403');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: 'Bearer secret-token' } });
  });
});
