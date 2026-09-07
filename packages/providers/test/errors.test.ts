import { describe, expect, it } from 'vitest';

import {
  classifyProviderError,
  ProviderHttpError,
  ProviderNetworkError,
  ProviderTimeoutError,
} from '../src/index.js';

describe('classifyProviderError', () => {
  it.each([
    [401, 'authentication', false],
    [403, 'permission', false],
    [404, 'model_unavailable', false],
    [408, 'timeout', true],
    [422, 'invalid_response', true],
    [429, 'rate_limited', true],
    [500, 'server', true],
    [502, 'server', true],
    [503, 'server', true],
  ] as const)('maps HTTP %i to %s', (status, code, retryable) => {
    expect(
      classifyProviderError(new ProviderHttpError(status, 1_500, null)),
    ).toMatchObject({ code, retryable, status });
  });

  it('distinguishes an exhausted quota from a temporary rate limit', () => {
    expect(
      classifyProviderError(
        new ProviderHttpError(429, null, 'Monthly quota exhausted'),
      ),
    ).toMatchObject({ code: 'quota_exhausted', retryable: false });
  });

  it('separates cancellation, timeout, malformed data, and network failure', () => {
    expect(
      classifyProviderError(new DOMException('cancelled', 'AbortError')).code,
    ).toBe('cancelled');
    expect(classifyProviderError(new ProviderTimeoutError()).code).toBe(
      'timeout',
    );
    expect(classifyProviderError(new SyntaxError()).code).toBe(
      'invalid_response',
    );
    expect(classifyProviderError(new ProviderNetworkError()).code).toBe(
      'network',
    );
    expect(classifyProviderError(new TypeError()).code).toBe(
      'invalid_response',
    );
  });
});
