import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOAuthStateSigner } from '@walkz/github';

import { createHostedApi } from '../src/index.js';

const repositoryId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const apps: Array<ReturnType<typeof createHostedApi>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('hosted API composition', () => {
  it('serves every hosted boundary from one Fastify instance', async () => {
    const authenticator = { authenticate: vi.fn().mockResolvedValue(null) };
    const app = createHostedApi({
      githubAuth: {
        stateSigner: createOAuthStateSigner('a'.repeat(32)),
        oauthClient: { exchangeCode: vi.fn() },
        sessionIssuer: { create: vi.fn(), revoke: vi.fn() },
        stateStore: { store: vi.fn(), consume: vi.fn() },
        clientId: 'client-id',
        callbackUrl: 'https://walkz.test/auth/github/callback',
      },
      installations: {
        authenticator,
        repositories: { list: vi.fn(), select: vi.fn() },
      },
      manualReviews: {
        authenticator,
        reviews: { start: vi.fn() },
      },
      repositories: {
        authenticator,
        configHistory: { list: vi.fn() },
        reviewHistory: { list: vi.fn() },
      },
      webhook: {
        secret: 'webhook-secret',
        promptVersion: 'hosted-v1',
        intake: { accept: vi.fn() },
      },
    });
    apps.push(app);

    const [webhook, logout, installations, manualReview, configs, reviews] = await Promise.all([
      app.inject({ method: 'POST', url: '/webhooks/github', payload: {} }),
      app.inject({ method: 'POST', url: '/auth/logout' }),
      app.inject({ method: 'GET', url: '/api/installations/123/repositories' }),
      app.inject({ method: 'POST', url: `/api/repositories/${repositoryId}/pull-requests/1/reviews` }),
      app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/configs` }),
      app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/reviews` }),
    ]);

    expect(webhook.statusCode).toBe(401);
    expect(logout.statusCode).toBe(204);
    expect(installations.statusCode).toBe(401);
    expect(manualReview.statusCode).toBe(401);
    expect(configs.statusCode).toBe(401);
    expect(reviews.statusCode).toBe(401);
  });
});
