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
      telemetry: {
        load: vi.fn().mockResolvedValue({
          windowHours: 24,
          reviewRuns: {
            byStatus: { completed: 2 },
            byVerdict: { SHIP: 2 },
          },
          outbox: { pending: 0, oldestPendingAgeMs: null },
        }),
      },
      logger: {
        stream: {
          write(message: string) {
            logLines.push(message);
          },
        },
      },
    });
    apps.push(app);
    app.get('/test-error', async () => {
      throw new Error('sensitive request detail');
    });

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
      operational,
      failedRequest,
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
      app.inject({ method: 'GET', url: '/ops/telemetry' }),
      app.inject({ method: 'GET', url: '/test-error' }),
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
    expect(operational.statusCode).toBe(200);
    expect(operational.headers['cache-control']).toBe('private, no-store');
    expect(operational.json()).toMatchObject({
      schemaVersion: 1,
      service: 'api',
      dependencies: { postgres: { status: 'up' } },
      durable: {
        reviewRuns: { byVerdict: { SHIP: 2 } },
        outbox: { pending: 0 },
      },
    });
    expect(failedRequest.statusCode).toBe(500);
    expect(configs.headers['cache-control']).toBe('private, no-store');
    const logs = logLines.join('');
    expect(logs).toContain('/auth/github/callback');
    expect(logs).toContain('http_request_completed');
    expect(logs).toContain('/test-error');
    expect(logs).not.toContain('/ops/telemetry');
    expect(logs).not.toContain('sensitive-code');
    expect(logs).not.toContain('sensitive-state');
    expect(logs).not.toContain('sensitive request detail');
  });

  it('keeps liveness independent from database readiness', async () => {
    const authenticator = { authenticate: vi.fn().mockResolvedValue(null) };
    const telemetryLoad = vi.fn().mockReturnValue(new Promise(() => undefined));
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
      telemetry: {
        load: telemetryLoad,
        timeoutMs: 20,
      },
    });
    apps.push(app);

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    const [operational, repeatedOperational] = await Promise.all([
      app.inject({ method: 'GET', url: '/ops/telemetry' }),
      app.inject({ method: 'GET', url: '/ops/telemetry' }),
    ]);

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'not_ready' });
    expect(ready.body).not.toContain('database secret');
    expect(operational.statusCode).toBe(503);
    expect(repeatedOperational.statusCode).toBe(503);
    expect(telemetryLoad).toHaveBeenCalledOnce();
    expect(operational.json()).toMatchObject({
      service: 'api',
      dependencies: { postgres: { status: 'down' } },
      process: { requests: { total: 0 } },
      durable: null,
    });
    expect(operational.body).not.toContain('Operational telemetry deadline');
  });
});
