import { describe, expect, it } from 'vitest';

import { loadDashboardReviews } from './reviews.js';

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
              pullRequestId: '#12',
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
      pullRequestId: null,
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
