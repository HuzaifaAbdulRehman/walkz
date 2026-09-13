import type {
  ProviderAdapter,
  StructuredPatchRequest,
  StructuredReviewRequest,
} from '@walkz/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  ProviderTimeoutError,
  withModelInvocationTelemetry,
} from '../src/index.js';

const reviewRequest: StructuredReviewRequest = {
  model: 'model-1',
  systemPrompt: 'private system prompt',
  userPrompt: 'private source code',
  maxOutputTokens: 1_000,
  promptVersion: 'review-v1',
};
const patchRequest: StructuredPatchRequest = {
  ...reviewRequest,
  promptVersion: 'patch-v1',
};

function provider(): ProviderAdapter {
  return {
    name: 'mock',
    listModels: vi.fn().mockResolvedValue([]),
    validateAccess: vi.fn().mockResolvedValue({
      provider: 'mock',
      selectedModel: 'model-1',
      models: [],
      privacyNotice: 'Local test provider.',
      dataControlsUrl: null,
    }),
    requestStructuredReview: vi.fn().mockResolvedValue({
      provider: 'mock',
      model: 'model-1',
      promptVersion: 'review-v1',
      schemaVersion: 'review-schema-v1',
      review: { findings: [] },
      usage: usage(),
      requestId: 'review-request',
    }),
    requestStructuredPatch: vi.fn().mockResolvedValue({
      provider: 'mock',
      model: 'model-1',
      promptVersion: 'patch-v1',
      schemaVersion: 'patch-schema-v1',
      patch: {
        findingId: 'finding-1',
        headSha: 'a'.repeat(40),
        path: 'src/value.ts',
        startLine: 1,
        endLine: 1,
        replacement: 'return 1;',
        approvalRequired: true,
      },
      usage: usage(),
      requestId: 'patch-request',
    }),
  };
}

function usage() {
  return {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    latencyMs: 20,
    rateLimit: {
      retryAfterMs: null,
      remainingRequests: null,
      remainingTokens: null,
      resetRequests: null,
      resetTokens: null,
    },
  };
}

function clock(...values: number[]): () => number {
  const next = vi.fn();
  for (const value of values) next.mockReturnValueOnce(value);
  return next;
}

describe('model invocation telemetry', () => {
  it('records review hashes without exposing private inputs', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const observed = withModelInvocationTelemetry(provider(), {
      operationId: 'review:run-1',
      record,
      now: clock(100, 125),
    });

    await observed.requestStructuredReview(reviewRequest);

    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'review',
      status: 'succeeded',
      provider: 'mock',
      model: 'model-1',
      promptVersion: 'review-v1',
      requestId: 'review-request',
      durationMs: 25,
      usage: expect.objectContaining({ totalTokens: 15 }),
      invocationKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      responseHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }));
    const serialized = JSON.stringify(record.mock.calls[0]?.[0]);
    expect(serialized).not.toContain('private system prompt');
    expect(serialized).not.toContain('private source code');
  });

  it('uses a distinct logical key for patch generation', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const observed = withModelInvocationTelemetry(provider(), {
      operationId: 'review:run-1',
      record,
      now: clock(100, 120, 200, 230),
    });

    await observed.requestStructuredReview(reviewRequest);
    await observed.requestStructuredPatch!(patchRequest);

    expect(record).toHaveBeenNthCalledWith(2, expect.objectContaining({
      stage: 'patch',
      status: 'succeeded',
      requestId: 'patch-request',
    }));
    expect(record.mock.calls[0]?.[0].invocationKey)
      .not.toBe(record.mock.calls[1]?.[0].invocationKey);
  });

  it('records normalized failures and preserves the provider error', async () => {
    const selected = provider();
    const failure = new ProviderTimeoutError();
    selected.requestStructuredReview = vi.fn().mockRejectedValue(failure);
    const record = vi.fn().mockResolvedValue(undefined);
    const observed = withModelInvocationTelemetry(selected, {
      operationId: 'review:run-1',
      record,
      now: clock(100, 130),
    });

    await expect(observed.requestStructuredReview(reviewRequest)).rejects.toBe(failure);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'review',
      status: 'failed',
      responseHash: null,
      usage: null,
      requestId: null,
      errorCode: 'timeout',
      durationMs: 30,
    }));
  });

  it('does not release model output when recording fails', async () => {
    const record = vi.fn().mockRejectedValue(new Error('database unavailable'));
    const observed = withModelInvocationTelemetry(provider(), {
      operationId: 'review:run-1',
      record,
    });

    await expect(observed.requestStructuredReview(reviewRequest))
      .rejects.toThrow('database unavailable');
    expect(record).toHaveBeenCalledOnce();
  });
});
