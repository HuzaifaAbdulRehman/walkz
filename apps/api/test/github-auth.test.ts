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
    const app = createGitHubAuthApi({
      stateSigner: createOAuthStateSigner(secret),
      oauthClient: { exchangeCode: vi.fn() },
      sessionIssuer: { create: vi.fn() },
      clientId: 'client-id',
      callbackUrl: 'https://walkz.test/auth/github/callback',
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/auth/github/start' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('client_id=client-id');
    expect(response.headers.location).toContain('state=');
  });

  it('stores the exchanged token server-side and returns only a session cookie', async () => {
    const stateSigner = createOAuthStateSigner(secret);
    const exchangeCode = vi.fn().mockResolvedValue({ accessToken: 'token' });
    const sessionIssuer = { create: vi.fn().mockResolvedValue({ sessionId: 'session-id' }) };
    const app = createGitHubAuthApi({
      stateSigner,
      oauthClient: { exchangeCode },
      sessionIssuer,
      clientId: 'client-id',
      callbackUrl: 'https://walkz.test/auth/github/callback',
    });
    apps.push(app);
    const state = stateSigner.issue({ stateId: '3d963b52-8203-4ba6-bcac-15bf132371f0', returnTo: '/reviews' });

    const response = await app.inject({ method: 'GET', url: `/auth/github/callback?code=code&state=${encodeURIComponent(state)}` });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/reviews');
    expect(response.headers['set-cookie']).toContain('walkz_session=session-id');
    expect(response.body).not.toContain('token');
    expect(sessionIssuer.create).toHaveBeenCalledWith('token');
  });
});
