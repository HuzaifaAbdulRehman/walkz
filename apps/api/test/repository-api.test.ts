import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultWalkzConfig } from '@walkz/contracts';

import { createRepositoryApi } from '../src/index.js';

const repositoryId = '3d963b52-8203-4ba6-bcac-15bf132371f0';
const otherRepositoryId = '08d0dd85-734e-4f74-bcfc-3436ec7b4abd';
const userId = '79f36b7d-919f-480f-931b-cf62ce0141d9';
const findingId = '2d437195-a9f0-4af9-aaf4-3cbda1c8f61f';
const requestId = '67a36bd7-3392-4b07-b73e-c80da09e17ae';
const apps: Array<ReturnType<typeof createRepositoryApi>> = [];

const identity = (repositoryIds: string[]) => ({ userId, repositoryIds });
const findingsStore = (overrides: Record<string, unknown> = {}) => ({
  list: vi.fn().mockResolvedValue([]),
  recordFeedback: vi.fn(),
  ...overrides,
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('authenticated repository API', () => {
  it('returns configuration history for an authorized repository', async () => {
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue(identity([repositoryId])) },
      configHistory: {
        list: vi.fn().mockResolvedValue([{
          id: 'config-1',
          schemaVersion: 1,
          configHash: 'a'.repeat(64),
          createdAt: new Date('2026-09-09T12:00:00.000Z'),
          config: createDefaultWalkzConfig([{
            id: 'typecheck',
            executable: 'npm',
            args: ['run', 'typecheck', 'secret-shaped-value'],
            cwd: '.',
            required: true,
          }]),
        }]),
      },
      reviewHistory: { list: vi.fn().mockResolvedValue([]) },
      reviewFindings: findingsStore(),
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/configs` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configurations: [{
      id: 'config-1',
      schemaVersion: 1,
      configHash: 'a'.repeat(64),
      createdAt: '2026-09-09T12:00:00.000Z',
      provider: { name: 'groq', model: 'auto' },
      budget: {
        diffBytes: 524_288,
        files: 100,
        tokens: 16_000,
        commandTimeoutMs: 120_000,
        commandOutputBytesPerStream: 262_144,
      },
      triggerPolicy: 'manual',
      blockingEvidenceLevels: ['VERIFIED'],
      commandApprovalPolicy: 'prompt',
      commandCount: 1,
      requiredCommandCount: 1,
      premiumEnabled: false,
      spendingLimitUsd: 0,
    }] });
    expect(response.body).not.toContain('secret-shaped-value');
    expect(response.body).not.toContain('executable');
    expect(response.body).not.toContain('commands');
  });

  it('rejects access to another repository', async () => {
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue(identity([otherRepositoryId])) },
      configHistory: { list: vi.fn() },
      reviewHistory: { list: vi.fn() },
      reviewFindings: findingsStore(),
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/configs` });

    expect(response.statusCode).toBe(403);
  });

  it('requires an authenticated session', async () => {
    const list = vi.fn();
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue(null) },
      configHistory: { list },
      reviewHistory: { list },
      reviewFindings: findingsStore({ list }),
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/configs` });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'authentication_required' });
    expect(list).not.toHaveBeenCalled();
  });

  it('returns review history for an authorized repository', async () => {
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue(identity([repositoryId])) },
      configHistory: { list: vi.fn().mockResolvedValue([]) },
      reviewHistory: { list: vi.fn().mockResolvedValue([{ status: 'completed' }]) },
      reviewFindings: findingsStore(),
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: `/api/repositories/${repositoryId}/reviews` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reviews: [{ status: 'completed' }] });
  });

  it('returns named finding fields for an authorized review', async () => {
    const list = vi.fn().mockResolvedValue([{
      id: findingId,
      fingerprint: 'a'.repeat(64),
      category: 'correctness',
      severity: 'high',
      path: 'src/value.ts',
      startLine: 8,
      endLine: 9,
      lifecycleStatus: 'verified',
      evidenceLevel: 'VERIFIED',
      advisoryConfidence: 0.93,
      summary: 'The value can be stale.',
      claim: 'The value can be stale.',
      failureMechanism: 'The cache key omits the current revision.',
      suggestedProof: 'Request both revisions with the same key.',
      createdAt: new Date('2026-09-10T00:00:00.000Z'),
    }]);
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue(identity([repositoryId])) },
      configHistory: { list: vi.fn() },
      reviewHistory: { list: vi.fn() },
      reviewFindings: findingsStore({ list }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repositoryId}/reviews/${otherRepositoryId}/findings`,
    });

    expect(response.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(repositoryId, otherRepositoryId);
    expect(response.json()).toEqual({ findings: [{
      id: findingId,
      fingerprint: 'a'.repeat(64),
      category: 'correctness',
      severity: 'high',
      path: 'src/value.ts',
      startLine: 8,
      endLine: 9,
      lifecycleStatus: 'verified',
      evidenceLevel: 'VERIFIED',
      advisoryConfidence: 0.93,
      summary: 'The value can be stale.',
      claim: 'The value can be stale.',
      failureMechanism: 'The cache key omits the current revision.',
      suggestedProof: 'Request both revisions with the same key.',
      createdAt: '2026-09-10T00:00:00.000Z',
    }] });
  });

  it('does not query findings for another repository', async () => {
    const list = vi.fn();
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue(identity([otherRepositoryId])) },
      configHistory: { list: vi.fn() },
      reviewHistory: { list: vi.fn() },
      reviewFindings: findingsStore({ list }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: `/api/repositories/${repositoryId}/reviews/${otherRepositoryId}/findings`,
    });

    expect(response.statusCode).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });

  it('records idempotent false-positive feedback for an authorized finding', async () => {
    const recordFeedback = vi.fn().mockResolvedValue({
      outcome: 'created',
      feedback: {
        id: requestId,
        reviewRunId: otherRepositoryId,
        findingId,
        actorUserId: userId,
        assessment: 'false_positive',
        reason: 'incorrect_claim',
        createdAt: new Date('2026-09-13T10:00:00.000Z'),
      },
    });
    const app = createRepositoryApi({
      authenticator: { authenticate: vi.fn().mockResolvedValue(identity([repositoryId])) },
      configHistory: { list: vi.fn() },
      reviewHistory: { list: vi.fn() },
      reviewFindings: findingsStore({ recordFeedback }),
    });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: `/api/repositories/${repositoryId}/reviews/${otherRepositoryId}/findings/${findingId}/feedback`,
      payload: {
        requestId,
        assessment: 'false_positive',
        reason: 'incorrect_claim',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(recordFeedback).toHaveBeenCalledWith({
      requestId,
      repositoryId,
      reviewRunId: otherRepositoryId,
      findingId,
      actorUserId: userId,
      assessment: 'false_positive',
      reason: 'incorrect_claim',
    });
    expect(response.json()).toEqual({
      outcome: 'created',
      feedback: {
        assessment: 'false_positive',
        reason: 'incorrect_claim',
        createdAt: '2026-09-13T10:00:00.000Z',
      },
    });
  });
});
