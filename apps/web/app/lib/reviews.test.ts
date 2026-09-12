import { describe, expect, it } from 'vitest';

import {
  loadDashboardConfigurations,
  loadDashboardFindings,
  loadDashboardInstallations,
  loadDashboardReviews,
} from './reviews.js';

describe('loadDashboardInstallations', () => {
  it('loads repository choices for the signed-in user', async () => {
    const fetcher = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      expect(String(input)).toBe('https://api.example.test/api/installations');
      expect(init?.headers).toEqual({ cookie: 'walkz_session=session-1' });
      return new Response(JSON.stringify({ installations: [{
        id: '123',
        repositories: [{
          id: '456',
          owner: 'octocat',
          name: 'hello-world',
          selectedRepositoryId: 'fdad3d5a-bbbb-4be3-8cb5-fc08fc1a4357',
        }],
      }] }), { status: 200 });
    };

    await expect(loadDashboardInstallations(
      'https://api.example.test/',
      'walkz_session=session-1',
      fetcher,
    )).resolves.toEqual([{
      id: '123',
      repositories: [{
        id: '456',
        owner: 'octocat',
        name: 'hello-world',
        selectedRepositoryId: 'fdad3d5a-bbbb-4be3-8cb5-fc08fc1a4357',
      }],
    }]);
  });

  it('rejects an invalid selected repository identifier', async () => {
    const fetcher = async () => new Response(JSON.stringify({ installations: [{
      id: '123',
      repositories: [{
        id: '456',
        owner: 'octocat',
        name: 'hello-world',
        selectedRepositoryId: '456',
      }],
    }] }), { status: 200 });

    await expect(loadDashboardInstallations(
      'https://api.example.test',
      'walkz_session=session-1',
      fetcher,
    )).rejects.toThrow('Installation response was invalid.');
  });

  it('reports an expired session without treating it as an outage', async () => {
    const fetcher = async () => new Response(
      JSON.stringify({ error: 'authentication_required' }),
      { status: 401 },
    );

    await expect(loadDashboardInstallations(
      'https://api.example.test',
      'walkz_session=expired',
      fetcher,
    )).resolves.toBeNull();
  });
});

describe('loadDashboardReviews', () => {
  it('returns no reviews when the hosted API is not configured', async () => {
    await expect(loadDashboardReviews(undefined, undefined, undefined)).resolves.toEqual([]);
    await expect(loadDashboardReviews(' ', 'repo-1', undefined)).resolves.toEqual([]);
  });

  it('loads and validates privacy-safe review history', async () => {
    const fetcher = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(String(input)).toBe('https://api.example.test/api/repositories/repo-1/reviews');
      expect(init?.headers).toEqual({ cookie: 'walkz_session=session-1' });
      return new Response(
        JSON.stringify({
          reviews: [
            {
              id: 'run-1',
              pullRequestNumber: 12,
              baseSha: 'a'.repeat(40),
              headSha: 'b'.repeat(40),
              status: 'completed',
              verdict: 'SHIP',
              resultSummary: 'No blocking evidence.',
              createdAt: '2026-09-09T12:00:00.000Z',
              completedAt: '2026-09-09T12:01:00.000Z',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    await expect(
      loadDashboardReviews('https://api.example.test/', 'repo-1', 'walkz_session=session-1', fetcher),
    ).resolves.toHaveLength(1);
  });

  it('rejects malformed history responses', async () => {
    const fetcher = async () => new Response(JSON.stringify({ reviews: [{ id: 'run-1' }] }), { status: 200 });
    await expect(loadDashboardReviews('https://api.example.test', 'repo-1', undefined, fetcher)).rejects.toThrow(
      'Review history response was invalid.',
    );
  });

  it('rejects an invalid terminal result', async () => {
    const fetcher = async () => new Response(JSON.stringify({ reviews: [{
      id: 'run-1',
      pullRequestNumber: null,
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      status: 'completed',
      verdict: 42,
      resultSummary: null,
      createdAt: '2026-09-09T12:00:00.000Z',
      completedAt: '2026-09-09T12:01:00.000Z',
    }] }), { status: 200 });

    await expect(loadDashboardReviews('https://api.example.test', 'repo-1', undefined, fetcher)).rejects.toThrow(
      'Review history response was invalid.',
    );
  });
});

describe('loadDashboardFindings', () => {
  it('loads and validates one review finding', async () => {
    const fetcher = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      expect(String(input)).toBe(
        'https://api.example.test/api/repositories/repo-1/reviews/run-1/findings',
      );
      expect(init?.headers).toEqual({ cookie: 'walkz_session=session-1' });
      return new Response(JSON.stringify({ findings: [{
        id: '2d437195-a9f0-4af9-aaf4-3cbda1c8f61f',
        fingerprint: 'a'.repeat(64),
        category: 'correctness',
        severity: 'high',
        path: 'src/value.ts',
        startLine: 8,
        endLine: 9,
        lifecycleStatus: 'verified',
        evidenceLevel: 'VERIFIED',
        advisoryConfidence: 0.93,
        summary: 'The cached value can be stale.',
        claim: 'The cached value can be stale.',
        failureMechanism: 'The cache key omits the current revision.',
        suggestedProof: 'Request both revisions with the same key.',
        createdAt: '2026-09-10T00:00:00.000Z',
      }] }), { status: 200 });
    };

    await expect(loadDashboardFindings(
      'https://api.example.test/',
      'repo-1',
      'run-1',
      'walkz_session=session-1',
      fetcher,
    )).resolves.toHaveLength(1);
  });

  it('rejects malformed review findings', async () => {
    const fetcher = async () => new Response(JSON.stringify({
      findings: [{ fingerprint: 'not-a-fingerprint' }],
    }), { status: 200 });

    await expect(loadDashboardFindings(
      'https://api.example.test',
      'repo-1',
      'run-1',
      undefined,
      fetcher,
    )).rejects.toThrow('Review findings response was invalid.');
  });
});

describe('loadDashboardConfigurations', () => {
  it('loads a safe configuration summary without command text', async () => {
    const fetcher = async () => new Response(JSON.stringify({ configurations: [{
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
      commands: [{ args: ['not-allowed'] }],
    }] }), { status: 200 });

    await expect(loadDashboardConfigurations(
      'https://api.example.test',
      'repo-1',
      undefined,
      fetcher,
    )).resolves.toEqual([{
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
    }]);
  });

  it('rejects malformed configuration history', async () => {
    const fetcher = async () => new Response(JSON.stringify({ configurations: [{ id: 'config-1' }] }), {
      status: 200,
    });

    await expect(loadDashboardConfigurations(
      'https://api.example.test',
      'repo-1',
      undefined,
      fetcher,
    )).rejects.toThrow('Configuration history response was invalid.');
  });

  it('rejects an invalid configuration budget', async () => {
    const fetcher = async () => new Response(JSON.stringify({ configurations: [{
      id: 'config-1', schemaVersion: 1, configHash: 'a'.repeat(64), createdAt: '2026-09-09T12:00:00.000Z',
      provider: { name: 'groq', model: 'auto' },
      budget: { diffBytes: -1, files: 100, tokens: 16_000, commandTimeoutMs: 120_000, commandOutputBytesPerStream: 262_144 },
      triggerPolicy: 'manual', blockingEvidenceLevels: ['VERIFIED'], commandApprovalPolicy: 'prompt',
      commandCount: 0, requiredCommandCount: 0, premiumEnabled: false, spendingLimitUsd: 0,
    }] }), { status: 200 });

    await expect(loadDashboardConfigurations(
      'https://api.example.test', 'repo-1', undefined, fetcher,
    )).rejects.toThrow('Configuration history response was invalid.');
  });
});
