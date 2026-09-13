import { describe, expect, it } from 'vitest';

import { parseModelInvocationEvent } from '../src/index.js';

const hash = (value: string): string => value.repeat(64);

function successfulEvent() {
  return {
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

describe('model invocation events', () => {
  it('accepts bounded metadata and normalizes hashes', () => {
    const event = successfulEvent();

    expect(parseModelInvocationEvent({
      ...event,
      promptHash: event.promptHash.toUpperCase(),
    })).toMatchObject({ promptHash: event.promptHash });
  });

  it('requires internally consistent successful usage', () => {
    const event = successfulEvent();

    expect(() => parseModelInvocationEvent({
      ...event,
      usage: { ...event.usage, totalTokens: 124 },
    })).toThrow();
    expect(() => parseModelInvocationEvent({
      ...event,
      responseHash: null,
    })).toThrow();
  });

  it('rejects private payload fields and malformed failures', () => {
    const event = successfulEvent();

    expect(() => parseModelInvocationEvent({
      ...event,
      rawPrompt: 'private source',
    })).toThrow();
    expect(() => parseModelInvocationEvent({
      ...event,
      status: 'failed',
      responseHash: null,
      usage: null,
      errorCode: null,
    })).toThrow();
  });
});
