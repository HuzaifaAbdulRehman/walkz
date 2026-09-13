import type { StructuredReviewRequest } from '@walkz/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  createGroqProvider,
  requestStructuredReview,
} from '../src/index.js';

const API_KEY = 'groq-test-key';
const MODEL = 'openai/gpt-oss-120b';
const reviewRequest: StructuredReviewRequest = {
  model: MODEL,
  systemPrompt: 'Review only the supplied diff.',
  userPrompt: 'diff --git a/src/a.ts b/src/a.ts',
  maxOutputTokens: 2_000,
  promptVersion: 'review-v1',
};

function finding(overrides: Record<string, unknown> = {}) {
  return {
    category: 'correctness',
    severity: 'high',
    file: 'src/a.ts',
    line: 4,
    endLine: null,
    claim: 'The new branch returns the wrong value.',
    failureMechanism: 'The condition reverses the expected result.',
    suggestedProof: 'Call the branch with the boundary input.',
    confidence: 0.9,
    ...overrides,
  };
}

function completionResponse(
  options: {
    content?: string;
    model?: string;
    finishReason?: string;
    status?: number;
    headers?: ConstructorParameters<typeof Headers>[0];
  } = {},
): Response {
  const status = options.status ?? 200;
  if (status !== 200) {
    return new Response(
      JSON.stringify({ error: { message: 'Provider failure' } }),
      {
        status,
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
    );
  }
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      model: options.model ?? MODEL,
      choices: [
        {
          finish_reason: options.finishReason ?? 'stop',
          message: {
            role: 'assistant',
            content:
              options.content ?? JSON.stringify({ findings: [finding()] }),
          },
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 40,
        total_tokens: 140,
      },
      x_groq: { id: 'groq-request-1' },
    }),
    {
      status,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    },
  );
}

describe('Groq structured review', () => {
  it('sends a strict schema with no tool authority', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(input.toString()).toBe(
        'https://api.groq.com/openai/v1/chat/completions',
      );
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer ' + API_KEY,
      );
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        messages: unknown;
        response_format: {
          type: string;
          json_schema: {
            strict: boolean;
            schema: {
              additionalProperties: boolean;
              properties: {
                findings: { items: { required: string[] } };
              };
            };
          };
        };
      };
      expect(body).not.toHaveProperty('tools');
      expect(body).not.toHaveProperty('temperature');
      expect(body.model).toBe(MODEL);
      expect(body.messages).toEqual([
        { role: 'system', content: reviewRequest.systemPrompt },
        { role: 'user', content: reviewRequest.userPrompt },
      ]);
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body.response_format.json_schema.schema.additionalProperties).toBe(
        false,
      );
      expect(
        body.response_format.json_schema.schema.properties.findings.items
          .required,
      ).toContain('endLine');
      return completionResponse({
        headers: {
          'x-request-id': 'header-request-1',
          'x-ratelimit-remaining-requests': '999',
          'x-ratelimit-remaining-tokens': '12345',
          'x-ratelimit-reset-requests': '2m59.56s',
          'x-ratelimit-reset-tokens': '7.66s',
        },
      });
    });
    const clock = vi.fn<() => number>()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(125);

    const result = await requestStructuredReview(reviewRequest, {
      apiKey: API_KEY,
      fetch: fetchMock,
      monotonicNow: clock,
    });

    expect(result).toEqual({
      provider: 'groq',
      model: MODEL,
      promptVersion: 'review-v1',
      schemaVersion: 'walkz-review-v1',
      review: {
        findings: [
          {
            category: 'correctness',
            severity: 'high',
            file: 'src/a.ts',
            line: 4,
            claim: 'The new branch returns the wrong value.',
            failureMechanism: 'The condition reverses the expected result.',
            suggestedProof: 'Call the branch with the boundary input.',
            confidence: 0.9,
          },
        ],
      },
      usage: {
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
        latencyMs: 25,
        rateLimit: {
          retryAfterMs: null,
          remainingRequests: 999,
          remainingTokens: 12_345,
          resetRequests: '2m59.56s',
          resetTokens: '7.66s',
        },
      },
      requestId: 'header-request-1',
    });
  });

  it('rejects malformed envelopes and structured content', async () => {
    const envelopeFetch = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    );
    await expect(
      requestStructuredReview(reviewRequest, {
        apiKey: API_KEY,
        fetch: envelopeFetch,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response', retryable: false });

    const contentFetch = vi.fn<typeof fetch>(async () =>
      completionResponse({ content: '{bad json' }),
    );
    await expect(
      requestStructuredReview(reviewRequest, {
        apiKey: API_KEY,
        fetch: contentFetch,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('validates model findings again at the contract boundary', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      completionResponse({
        content: JSON.stringify({ findings: [finding({ line: 0 })] }),
      }),
    );

    await expect(
      requestStructuredReview(reviewRequest, {
        apiKey: API_KEY,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('rejects a response attributed to another model', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      completionResponse({ model: 'openai/gpt-oss-20b' }),
    );

    await expect(
      requestStructuredReview(reviewRequest, {
        apiKey: API_KEY,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('rejects content from an unfinished completion', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      completionResponse({ finishReason: 'length' }),
    );

    await expect(
      requestStructuredReview(reviewRequest, {
        apiKey: API_KEY,
        fetch: fetchMock,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('honours Retry-After at the only retry layer', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        completionResponse({
          status: 429,
          headers: { 'retry-after': '1.5' },
        }),
      )
      .mockResolvedValueOnce(completionResponse());
    const sleep = vi.fn(async () => undefined);

    await expect(
      requestStructuredReview(reviewRequest, {
        apiKey: API_KEY,
        fetch: fetchMock,
        random: () => 0,
        sleep,
      }),
    ).resolves.toMatchObject({ provider: 'groq', model: MODEL });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(1_500, undefined);
  });

  it('caps transient retries by attempt count', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      completionResponse({ status: 503 }),
    );
    const sleep = vi.fn(async () => undefined);

    await expect(
      requestStructuredReview(reviewRequest, {
        apiKey: API_KEY,
        fetch: fetchMock,
        maxAttempts: 3,
        random: () => 0,
        sleep,
      }),
    ).rejects.toMatchObject({ code: 'server', retryable: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry deterministic provider failures', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      completionResponse({ status: 401 }),
    );
    const sleep = vi.fn(async () => undefined);

    await expect(
      requestStructuredReview(reviewRequest, {
        apiKey: API_KEY,
        fetch: fetchMock,
        sleep,
      }),
    ).rejects.toMatchObject({ code: 'authentication', retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops before a retry when the caller cancels', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async () =>
      completionResponse({ status: 503 }),
    );
    const sleep = vi.fn(async () => {
      controller.abort();
    });

    await expect(
      requestStructuredReview(
        reviewRequest,
        { apiKey: API_KEY, fetch: fetchMock, sleep },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'cancelled', retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('cancels the built-in retry wait', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      queueMicrotask(() => controller.abort());
      return completionResponse({ status: 503 });
    });

    await expect(
      requestStructuredReview(
        reviewRequest,
        { apiKey: API_KEY, fetch: fetchMock, random: () => 1 },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'cancelled', retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects non-strict models and invalid retry policy before fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      requestStructuredReview(
        { ...reviewRequest, model: 'other/model' },
        { apiKey: API_KEY, fetch: fetchMock },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      requestStructuredReview(reviewRequest, {
        apiKey: API_KEY,
        fetch: fetchMock,
        maxAttempts: 0,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes the same behavior through the provider adapter', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => completionResponse());
    const provider = createGroqProvider({
      apiKey: API_KEY,
      fetch: fetchMock,
      monotonicNow: () => 0,
    });

    expect(provider.name).toBe('groq');
    await expect(
      provider.requestStructuredReview(reviewRequest),
    ).resolves.toMatchObject({ provider: 'groq', model: MODEL });
    await expect(
      provider.requestStructuredSecurityReview?.({
        ...reviewRequest,
        promptVersion: 'walkz-security-v1',
      }),
    ).resolves.toMatchObject({
      provider: 'groq',
      model: MODEL,
      promptVersion: 'walkz-security-v1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
