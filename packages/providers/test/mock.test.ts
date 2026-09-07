import type { StructuredReviewRequest } from '@walkz/contracts';
import { describe, expect, it } from 'vitest';

import { createMockProvider } from '../src/index.js';

const request: StructuredReviewRequest = {
  model: 'mock/reviewer',
  systemPrompt: 'Review the change.',
  userPrompt: 'diff --git a/a.ts b/a.ts',
  maxOutputTokens: 1_000,
  promptVersion: 'review-v1',
};
const cleanReview = { findings: [] };

describe('createMockProvider', () => {
  it('reports an in-process model and privacy notice', async () => {
    const provider = createMockProvider();

    expect(provider.name).toBe('mock');
    await expect(provider.listModels()).resolves.toEqual([
      {
        id: 'mock/reviewer',
        active: true,
        contextWindow: 131_072,
        maxCompletionTokens: 32_768,
        supportsStrictStructuredOutput: true,
      },
    ]);
    await expect(provider.validateAccess('auto')).resolves.toMatchObject({
      provider: 'mock',
      selectedModel: 'mock/reviewer',
      dataControlsUrl: null,
      privacyNotice:
        'The mock provider runs in this process and sends no data over the network.',
    });
  });

  it('returns one explicit queued review at a time', async () => {
    const provider = createMockProvider({
      outcomes: [{ type: 'review', review: cleanReview }],
    });

    await expect(provider.requestStructuredReview(request)).resolves.toEqual({
      provider: 'mock',
      model: 'mock/reviewer',
      promptVersion: 'review-v1',
      schemaVersion: 'walkz-review-v1',
      review: cleanReview,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: 0,
        rateLimit: {
          retryAfterMs: null,
          remainingRequests: null,
          remainingTokens: null,
          resetRequests: null,
          resetTokens: null,
        },
      },
      requestId: 'mock-request-1',
    });
    await expect(
      provider.requestStructuredReview(request),
    ).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('rejects malformed queued output instead of repairing it', async () => {
    const provider = createMockProvider({
      outcomes: [{ type: 'review', review: { findings: 'none' } }],
    });

    await expect(
      provider.requestStructuredReview(request),
    ).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('throws the exact queued provider failure', async () => {
    const provider = createMockProvider({
      outcomes: [
        {
          type: 'error',
          failure: {
            code: 'rate_limited',
            message: 'The test rate limit was reached.',
            retryable: true,
            status: 429,
            retryAfterMs: 250,
          },
        },
      ],
    });

    await expect(
      provider.requestStructuredReview(request),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
      status: 429,
      retryAfterMs: 250,
    });
  });

  it('does not consume an outcome when cancelled', async () => {
    const provider = createMockProvider({
      outcomes: [{ type: 'review', review: cleanReview }],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.requestStructuredReview(request, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled', retryable: false });
    await expect(
      provider.requestStructuredReview(request),
    ).resolves.toMatchObject({ review: cleanReview });
  });

  it('rejects an unavailable model without consuming an outcome', async () => {
    const provider = createMockProvider({
      outcomes: [{ type: 'review', review: cleanReview }],
    });

    await expect(
      provider.requestStructuredReview({ ...request, model: 'missing/model' }),
    ).rejects.toMatchObject({ code: 'model_unavailable' });
    await expect(
      provider.requestStructuredReview(request),
    ).resolves.toMatchObject({ review: cleanReview });
  });
});
