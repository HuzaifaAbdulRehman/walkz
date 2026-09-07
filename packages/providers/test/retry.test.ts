import { describe, expect, it } from 'vitest';

import { calculateRetryDelay } from '../src/index.js';

describe('calculateRetryDelay', () => {
  it('uses bounded exponential jitter', () => {
    expect(
      calculateRetryDelay(0, {
        baseDelayMs: 200,
        maxDelayMs: 1_000,
        random: () => 0.5,
      }),
    ).toBe(100);
    expect(
      calculateRetryDelay(4, {
        baseDelayMs: 200,
        maxDelayMs: 1_000,
        random: () => 1,
      }),
    ).toBe(1_000);
  });

  it('never shortens Retry-After to the local backoff cap', () => {
    expect(
      calculateRetryDelay(0, {
        baseDelayMs: 200,
        maxDelayMs: 1_000,
        random: () => 0,
        retryAfterMs: 700,
      }),
    ).toBe(700);
    expect(
      calculateRetryDelay(0, {
        baseDelayMs: 200,
        maxDelayMs: 1_000,
        random: () => 0,
        retryAfterMs: 5_000,
      }),
    ).toBe(5_000);
  });

  it('rejects invalid retry policy input', () => {
    expect(() => calculateRetryDelay(-1)).toThrow('Retry attempt');
    expect(() =>
      calculateRetryDelay(0, { random: () => Number.NaN }),
    ).toThrow('random source');
  });
});
