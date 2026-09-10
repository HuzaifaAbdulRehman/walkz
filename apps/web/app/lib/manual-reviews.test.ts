import { describe, expect, it } from 'vitest';

import {
  manualReviewErrorMessage,
  parseManualReviewAcceptance,
  parsePullRequestNumber,
  shouldReuseManualReviewRequestId,
} from './manual-reviews.js';

describe('manual review dashboard boundary', () => {
  it('accepts only bounded positive pull request numbers', () => {
    expect(parsePullRequestNumber(' 42 ')).toBe(42);
    expect(parsePullRequestNumber('0')).toBeNull();
    expect(parsePullRequestNumber('-1')).toBeNull();
    expect(parsePullRequestNumber('1e3')).toBeNull();
    expect(parsePullRequestNumber('2147483648')).toBeNull();
  });

  it('accepts only a strict UUID run response', () => {
    const reviewRunId = '513f194f-ae06-4689-bdab-d1299e31f614';
    expect(parseManualReviewAcceptance({ reviewRunId })).toEqual({ reviewRunId });
    expect(() => parseManualReviewAcceptance({ reviewRunId, apiKey: 'secret' }))
      .toThrow('Manual review response was invalid.');
    expect(() => parseManualReviewAcceptance({ reviewRunId: 'run-1' }))
      .toThrow('Manual review response was invalid.');
  });

  it('turns safe API signals into recovery messages', () => {
    expect(manualReviewErrorMessage(401, { error: 'authentication_required' }))
      .toBe('Your session expired. Sign in again.');
    expect(manualReviewErrorMessage(403, { error: 'repository_forbidden' }))
      .toBe('Walkz no longer has access to this repository.');
    expect(manualReviewErrorMessage(400, { error: 'invalid_idempotency_key' }))
      .toBe('Walkz could not start the review. Refresh the page and try again.');
    expect(manualReviewErrorMessage(502, { error: 'hosted_api_request_failed' }))
      .toBe('Walkz could not confirm whether the review started. Try again safely.');
  });

  it('reuses request IDs only when delivery is uncertain', () => {
    expect(shouldReuseManualReviewRequestId(502)).toBe(true);
    expect(shouldReuseManualReviewRequestId(400)).toBe(false);
  });
});
