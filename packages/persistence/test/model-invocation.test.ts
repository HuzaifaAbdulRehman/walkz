import { describe, expect, it, vi } from 'vitest';

import { recordModelInvocation } from '../src/index.js';

const hash = (value: string): string => value.repeat(64);
const reviewRunId = '1540d494-7f54-4ea1-8e8b-08ad9802b997';

function invocation() {
  return {
    reviewRunId,
    invocationKey: hash('a'),
    stage: 'review',
    status: 'succeeded',
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    promptVersion: 'walkz-review-v1',
    promptHash: hash('b'),
    responseHash: hash('c'),
    usage: {
      promptTokens: 100,
      completionTokens: 25,
      totalTokens: 125,
      latencyMs: 40,
      rateLimit: {
        retryAfterMs: null,
        remainingRequests: 99,
        remainingTokens: 10_000,
        resetRequests: '1m',
        resetTokens: '2s',
      },
    },
    requestId: 'request-1',
    errorCode: null,
    durationMs: 40,
  } as const;
}

describe('model invocation persistence', () => {
  it('stores only validated metadata and hashes', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: 'df9363c7-3a05-47d6-889f-1a625d13c8c6',
        status: 'succeeded',
        attemptCount: 1,
      }],
    });

    await expect(recordModelInvocation({ query }, invocation())).resolves.toEqual({
      id: 'df9363c7-3a05-47d6-889f-1a625d13c8c6',
      status: 'succeeded',
      attemptCount: 1,
    });
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ON CONFLICT (review_run_id, invocation_key)');
    expect(values).not.toContain('private source');
    expect(JSON.stringify(values)).not.toContain('rawPrompt');
  });

  it('rejects unknown payload fields before querying', async () => {
    const query = vi.fn();

    await expect(recordModelInvocation({ query }, {
      ...invocation(),
      rawResponse: 'private source',
    })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed when a replay conflicts', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });

    await expect(recordModelInvocation({ query }, invocation()))
      .rejects.toThrow('conflicts with its immutable request or response');
  });
});
