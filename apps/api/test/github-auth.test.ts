import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOAuthStateSigner } from '@walkz/github';

import { createGitHubAuthApi } from '../src/index.js';

const apps: Array<ReturnType<typeof createGitHubAuthApi>> = [];
const secret = 'a'.repeat(32);

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GitHub OAuth API', () => {
  it('redirects to GitHub with signed state', async () => {
    const store = vi.fn().mockResolvedValue(undefined);
    const app = createGitHubAuthApi({
      stateSigner: createOAuthStateSigner(secret),
      oauthClient: { exchangeCode: vi.fn() },
      sessionIssuer: { create: vi.fn(), revoke: vi.fn() },
      stateStore: { store, consume: vi.fn() },
      clientId: 'client-id',
      callbackUrl: 'https://walkz.test/auth/github/callback',
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/auth/github/start' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('client_id=client-id');
    expect(response.headers.location).toContain('state=');
    expect(response.headers.location).not.toContain('scope=');
    expect(store).toHaveBeenCalledWith({
      stateId: expect.any(String),
      expiresAt: expect.any(Date),
    });
  });

  it('stores the exchanged token server-side and returns only a session cookie', async () => {
    const stateSigner = createOAuthStateSigner(secret);
    const exchangeCode = vi.fn().mockResolvedValue({ accessToken: 'token' });
    const sessionIssuer = {
      create: vi.fn().mockResolvedValue({
        sessionId: 'session-id',
        expiresAt: new Date('2026-09-09T13:00:00.000Z'),
      }),
      revoke: vi.fn(),
    };
    const app = createGitHubAuthApi({
      stateSigner,
      oauthClient: { exchangeCode },
      sessionIssuer,
      stateStore: { store: vi.fn(), consume: vi.fn().mockResolvedValue(true) },
      clientId: 'client-id',
      callbackUrl: 'https://walkz.test/auth/github/callback',
      now: () => new Date('2026-09-09T12:00:00.000Z'),
    });
    apps.push(app);
    const state = stateSigner.issue({
      stateId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
      returnTo: '/',
    }).token;

    const response = await app.inject({ method: 'GET', url: `/auth/github/callback?code=code&state=${encodeURIComponent(state)}` });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/');
    expect(response.headers['set-cookie']).toContain('walkz_session=session-id');
    expect(response.headers['set-cookie']).toContain('Max-Age=3600');
    expect(response.body).not.toContain('token');
    expect(sessionIssuer.create).toHaveBeenCalledWith('token');
  });

  it('rejects a replay before exchanging the authorization code', async () => {
    const stateSigner = createOAuthStateSigner(secret);
    const exchangeCode = vi.fn();
    const app = createGitHubAuthApi({
      stateSigner,
      oauthClient: { exchangeCode },
      sessionIssuer: { create: vi.fn(), revoke: vi.fn() },
      stateStore: { store: vi.fn(), consume: vi.fn().mockResolvedValue(false) },
      clientId: 'client-id',
      callbackUrl: 'https://walkz.test/auth/github/callback',
    });
    apps.push(app);
    const state = stateSigner.issue({
      stateId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
      returnTo: '/',
    }).token;

    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=code&state=${encodeURIComponent(state)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'oauth_state_invalid' });
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('fails closed when durable state cannot be checked', async () => {
    const stateSigner = createOAuthStateSigner(secret);
    const exchangeCode = vi.fn();
    const app = createGitHubAuthApi({
      stateSigner,
      oauthClient: { exchangeCode },
      sessionIssuer: { create: vi.fn(), revoke: vi.fn() },
      stateStore: {
        store: vi.fn(),
        consume: vi.fn().mockRejectedValue(new Error('database unavailable')),
      },
      clientId: 'client-id',
      callbackUrl: 'https://walkz.test/auth/github/callback',
    });
    apps.push(app);
    const state = stateSigner.issue({
      stateId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
      returnTo: '/reviews',
    }).token;

    const response = await app.inject({
      method: 'GET',
      url: `/auth/github/callback?code=code&state=${encodeURIComponent(state)}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'authentication_unavailable' });
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('revokes the server session and clears the cookie on logout', async () => {
    const revoke = vi.fn().mockResolvedValue(true);
    const app = createGitHubAuthApi({
      stateSigner: createOAuthStateSigner(secret),
      oauthClient: { exchangeCode: vi.fn() },
      sessionIssuer: { create: vi.fn(), revoke },
      stateStore: { store: vi.fn(), consume: vi.fn() },
      clientId: 'client-id',
      callbackUrl: 'https://walkz.test/auth/github/callback',
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: 'other=value; walkz_session=' + 'a'.repeat(43) },
    });

    expect(response.statusCode).toBe(204);
    expect(revoke).toHaveBeenCalledWith('a'.repeat(43));
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
  });
});
