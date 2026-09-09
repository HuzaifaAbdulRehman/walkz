import { describe, expect, it, vi } from 'vitest';

import {
  createGitHubOAuthClient,
  createGitHubUserIdentityClient,
} from '../src/index.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GitHub user authentication clients', () => {
  it('exchanges a bounded authorization code without exposing the client secret', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      access_token: 'ghu_user-token',
      token_type: 'bearer',
      expires_in: 28_800,
    }));
    const client = createGitHubOAuthClient({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      callbackUrl: 'https://walkz.test/auth/github/callback',
      fetcher,
      timeoutMs: 1_000,
    });

    await expect(client.exchangeCode('temporary-code')).resolves.toEqual({
      accessToken: 'ghu_user-token',
    });
    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(request.body))).toEqual({
      client_id: 'client-id',
      client_secret: 'client-secret',
      code: 'temporary-code',
      redirect_uri: 'https://walkz.test/auth/github/callback',
    });

    fetcher.mockResolvedValueOnce(jsonResponse({ error: 'bad_verification_code' }, 401));
    await expect(client.exchangeCode('rejected-code')).rejects.toThrow(
      'GitHub OAuth exchange failed with status 401.',
    );
  });

  it('revalidates user identity and read-only installation permissions', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 123, login: 'octocat', extra: true }))
      .mockResolvedValueOnce(jsonResponse({ installations: [{
        id: 456,
        account: { login: 'octocat', id: 123 },
        permissions: {
          metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'write', issues: 'read',
        },
      }], total_count: 1 }))
      .mockResolvedValueOnce(jsonResponse({ repositories: [{
        id: 789,
        name: 'walkz',
        owner: { login: 'octocat' },
      }] }));

    await expect(createGitHubUserIdentityClient(fetcher).load('ghu_user-token')).resolves.toEqual({
      githubId: '123',
      login: 'octocat',
      installations: [{
        installationId: '456',
        accountLogin: 'octocat',
        repositories: [{ githubId: '789', owner: 'octocat', name: 'walkz' }],
      }],
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.github.com/user/installations?per_page=100&page=1',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer ghu_user-token' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('fails instead of truncating installations beyond the fixed ceiling', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      account: { login: `owner-${index + 1}` },
      permissions: {
        metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'write', issues: 'read',
      },
    }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 123, login: 'octocat' }))
      .mockResolvedValueOnce(jsonResponse({ installations: firstPage }))
      .mockResolvedValueOnce(jsonResponse({ installations: [{
        id: 101,
        account: { login: 'owner-101' },
        permissions: {
          metadata: 'read', contents: 'read', pull_requests: 'read', checks: 'write', issues: 'read',
        },
      }] }));

    await expect(createGitHubUserIdentityClient(fetcher).load('ghu_user-token')).rejects.toThrow(
      'GitHub installation discovery exceeded its safe limit.',
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'https://api.github.com/user/installations?per_page=1&page=101',
      expect.anything(),
    );
  });

  it('rejects installations with write access to source or pull requests', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 123, login: 'octocat' }))
      .mockResolvedValueOnce(jsonResponse({ installations: [{
        id: 456,
        account: { login: 'octocat' },
        permissions: {
          metadata: 'read', contents: 'write', pull_requests: 'read', checks: 'write', issues: 'read',
        },
      }] }));

    await expect(createGitHubUserIdentityClient(fetcher).load('ghu_user-token')).rejects.toThrow(
      'GitHub installation permissions exceed the Walkz boundary.',
    );
  });
});
