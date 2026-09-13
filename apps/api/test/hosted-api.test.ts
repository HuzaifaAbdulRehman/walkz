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
    const logLines: string[] = [];
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
      providerCredentials: {
        authenticator,
        credentials: { has: vi.fn(), save: vi.fn(), delete: vi.fn() },
        validator: { validate: vi.fn() },
      },
      patchFixes: {
        authenticator,
        store: {
          loadSource: vi.fn(), loadCredential: vi.fn(),
          recordModelInvocation: vi.fn(), create: vi.fn(),
          decide: vi.fn(), list: vi.fn(),
        },
        github: { forInstallation: vi.fn() },
        proofImage: `node@sha256:${'a'.repeat(64)}`,
      },
      patchSuggestions: {
        authenticator,
        publisher: { publish: vi.fn() },
      },
      repositories: {
        authenticator,
        configHistory: { list: vi.fn() },
        reviewHistory: { list: vi.fn() },
        reviewFindings: { list: vi.fn(), recordFeedback: vi.fn() },
      },
      webhook: {
        secret: 'webhook-secret',
        promptVersion: 'hosted-v1',
        intake: { accept: vi.fn() },
      },
      readiness: { check: vi.fn().mockResolvedValue(true) },
      logger: {
        stream: {
          write(message: string) {
            logLines.push(message);
          },
        },
      },
    });
    apps.push(app);

    const [
      webhook,
      logout,
      installations,
      installationSelection,
      manualReview,
      configs,
      reviews,
      findings,
      credentialStatus,
      patchDecision,
      patchSuggestion,
      callback,
    ] = await Promise.all([
      app.inject({ method: 'POST', url: '/webhooks/github', payload: {} }),
      app.inject({ method: 'POST', url: '/auth/logout' }),
      app.inject({ method: 'GET', url: '/api/installations/123/repositories' }),
      app.inject({
        method: 'POST',
        url: '/api/installations/123/repositories',
        payload: { repositoryId: '456' },
      }),
      app.inject({ method: 'POST', url: `/api/repositories/${repositoryId}/pull-requests/1/reviews` }),
      app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/configs` }),
      app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/reviews` }),
      app.inject({
        method: 'GET',
        url: `/api/repositories/${repositoryId}/reviews/${repositoryId}/findings`,
      }),
      app.inject({
        method: 'GET',
        url: `/api/repositories/${repositoryId}/provider-credentials/groq`,
      }),
      app.inject({
        method: 'POST',
        url: `/api/repositories/${repositoryId}/patch-proposals/${repositoryId}/decision`,
        payload: {},
      }),
      app.inject({
        method: 'POST',
        url: `/api/repositories/${repositoryId}/patch-proposals/${repositoryId}/publish-suggestion`,
        payload: {},
      }),
      app.inject({
        method: 'GET',
        url: '/auth/github/callback?code=sensitive-code&state=sensitive-state',
      }),
    ]);

    expect(webhook.statusCode).toBe(401);
    expect(logout.statusCode).toBe(204);
    expect(installations.statusCode).toBe(401);
    expect(installationSelection.statusCode).toBe(401);
    expect(manualReview.statusCode).toBe(401);
    expect(configs.statusCode).toBe(401);
    expect(reviews.statusCode).toBe(401);
    expect(findings.statusCode).toBe(401);
    expect(credentialStatus.statusCode).toBe(401);
    expect(patchDecision.statusCode).toBe(401);
    expect(patchSuggestion.statusCode).toBe(401);
    expect(callback.statusCode).toBe(400);
    expect(configs.headers['cache-control']).toBe('private, no-store');
    const logs = logLines.join('');
    expect(logs).toContain('/auth/github/callback');
    expect(logs).not.toContain('sensitive-code');
    expect(logs).not.toContain('sensitive-state');
  });

  it('keeps liveness independent from database readiness', async () => {
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
      installations: { authenticator, repositories: { list: vi.fn(), select: vi.fn() } },
      manualReviews: { authenticator, reviews: { start: vi.fn() } },
      providerCredentials: {
        authenticator,
        credentials: { has: vi.fn(), save: vi.fn(), delete: vi.fn() },
        validator: { validate: vi.fn() },
      },
      patchFixes: {
        authenticator,
        store: {
          loadSource: vi.fn(), loadCredential: vi.fn(),
          recordModelInvocation: vi.fn(), create: vi.fn(),
          decide: vi.fn(), list: vi.fn(),
        },
        github: { forInstallation: vi.fn() },
        proofImage: `node@sha256:${'a'.repeat(64)}`,
      },
      patchSuggestions: {
        authenticator,
        publisher: { publish: vi.fn() },
      },
      repositories: {
        authenticator,
        configHistory: { list: vi.fn() },
        reviewHistory: { list: vi.fn() },
        reviewFindings: { list: vi.fn(), recordFeedback: vi.fn() },
      },
      webhook: {
        secret: 'webhook-secret',
        promptVersion: 'hosted-v1',
        intake: { accept: vi.fn() },
      },
      readiness: { check: vi.fn().mockRejectedValue(new Error('database secret')) },
    });
    apps.push(app);

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not_ready' });
    expect(ready.body).not.toContain('database secret');
  });
});
