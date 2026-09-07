import { describe, expect, it, vi } from 'vitest';

import {
  discoverGroqModels,
  validateProviderAccess,
} from '../src/index.js';

const API_KEY = 'groq-test-key';

function model(
  id: string,
  options: { active?: boolean; contextWindow?: number | null } = {},
): Record<string, unknown> {
  return {
    id,
    active: options.active ?? true,
    context_window: options.contextWindow ?? 131_072,
    max_completion_tokens: 32_768,
    owned_by: 'Groq',
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: ConstructorParameters<typeof Headers>[0],
): Response {
  return new Response(JSON.stringify(body), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
}

describe('Groq model discovery', () => {
  it('uses the models endpoint without sending a request body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(input.toString()).toBe('https://api.groq.com/openai/v1/models');
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer ' + API_KEY,
      );
      return jsonResponse({ data: [model('openai/gpt-oss-120b')] });
    });

    await expect(
      discoverGroqModels({ apiKey: API_KEY, fetch: fetchMock }),
    ).resolves.toEqual([
      {
        id: 'openai/gpt-oss-120b',
        active: true,
        contextWindow: 131_072,
        maxCompletionTokens: 32_768,
        supportsStrictStructuredOutput: true,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('rejects an invalid model list', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [{ id: 'missing-active' }] }),
    );

    await expect(
      discoverGroqModels({ apiKey: API_KEY, fetch: fetchMock }),
    ).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('rejects malformed and oversized response bodies', async () => {
    const malformedFetch = vi.fn<typeof fetch>(async () =>
      new Response('{bad json', { status: 200 }),
    );
    await expect(
      discoverGroqModels({ apiKey: API_KEY, fetch: malformedFetch }),
    ).rejects.toMatchObject({ code: 'invalid_response' });

    const oversizedFetch = vi.fn<typeof fetch>(async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': '200' },
      }),
    );
    await expect(
      discoverGroqModels({
        apiKey: API_KEY,
        fetch: oversizedFetch,
        maxResponseBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('Groq access validation', () => {
  it('selects the preferred active strict model', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          model('openai/gpt-oss-20b'),
          model('qwen/qwen3.8-27b'),
          model('openai/gpt-oss-120b'),
          model('other/model'),
        ],
      }),
    );

    const access = await validateProviderAccess({
      apiKey: API_KEY,
      fetch: fetchMock,
    });

    expect(access).toMatchObject({
      provider: 'groq',
      selectedModel: 'openai/gpt-oss-120b',
      dataControlsUrl: 'https://console.groq.com/settings/data-controls',
    });
    expect(access.privacyNotice).toContain('temporary logging may apply');
  });

  it('accepts an explicitly selected active strict model', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [model('openai/gpt-oss-20b')] }),
    );

    await expect(
      validateProviderAccess({
        apiKey: API_KEY,
        requestedModel: 'openai/gpt-oss-20b',
        fetch: fetchMock,
      }),
    ).resolves.toMatchObject({ selectedModel: 'openai/gpt-oss-20b' });
  });

  it('rejects inactive and non-strict models', async () => {
    const inactiveFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [model('openai/gpt-oss-120b', { active: false })],
      }),
    );
    await expect(
      validateProviderAccess({ apiKey: API_KEY, fetch: inactiveFetch }),
    ).rejects.toMatchObject({ code: 'model_unavailable' });

    const looseFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({ data: [model('other/model')] }),
    );
    await expect(
      validateProviderAccess({
        apiKey: API_KEY,
        requestedModel: 'other/model',
        fetch: looseFetch,
      }),
    ).rejects.toMatchObject({ code: 'model_unavailable' });
  });

  it.each([
    [401, 'authentication', false],
    [403, 'permission', false],
    [429, 'rate_limited', true],
    [500, 'server', true],
    [502, 'server', true],
    [503, 'server', true],
  ] as const)('normalizes HTTP %i as %s', async (status, code, retryable) => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        { error: { message: 'Provider failure' } },
        status,
        status === 429 ? { 'retry-after': '1.5' } : undefined,
      ),
    );

    await expect(
      validateProviderAccess({ apiKey: API_KEY, fetch: fetchMock }),
    ).rejects.toMatchObject({
      code,
      retryable,
      status,
      retryAfterMs: status === 429 ? 1_500 : null,
    });
  });

  it('distinguishes exhausted quota from rate limiting', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        { error: { message: 'Daily quota exhausted' } },
        429,
      ),
    );

    await expect(
      validateProviderAccess({ apiKey: API_KEY, fetch: fetchMock }),
    ).rejects.toMatchObject({
      code: 'quota_exhausted',
      retryable: false,
    });
  });

  it('discards an unsafe Retry-After value', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        { error: { message: 'Provider failure' } },
        429,
        { 'retry-after': '1e309' },
      ),
    );

    await expect(
      validateProviderAccess({ apiKey: API_KEY, fetch: fetchMock }),
    ).rejects.toMatchObject({ code: 'rate_limited', retryAfterMs: null });
  });

  it('does not expose the API key in provider errors', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: { message: API_KEY } }, 401),
    );

    const error = await validateProviderAccess({
      apiKey: API_KEY,
      fetch: fetchMock,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'authentication' });
    expect(String(error)).not.toContain(API_KEY);
  });

  it('requires an API key before making a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      validateProviderAccess({ apiKey: '  ', fetch: fetchMock }),
    ).rejects.toMatchObject({ code: 'authentication', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('separates caller cancellation from request timeout', async () => {
    const hangingFetch = vi.fn<typeof fetch>(async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      }),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      validateProviderAccess({
        apiKey: API_KEY,
        fetch: hangingFetch,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled', retryable: false });

    await expect(
      validateProviderAccess({
        apiKey: API_KEY,
        fetch: hangingFetch,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });

  it('keeps the timeout active while reading the response body', async () => {
    const stalledBodyFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200 });
    });

    await expect(
      validateProviderAccess({
        apiKey: API_KEY,
        fetch: stalledBodyFetch,
        timeoutMs: 5,
      }),
    ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });

  it('normalizes transport failures without exposing their message', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('connect failed at internal-host');
    });

    const error = await validateProviderAccess({
      apiKey: API_KEY,
      fetch: fetchMock,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'network', retryable: true });
    expect(String(error)).not.toContain('internal-host');
  });
});
