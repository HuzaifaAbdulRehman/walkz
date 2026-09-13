import { describe, expect, it } from 'vitest';

import { parseFindingFeedbackRequest } from '../src/index.js';

const requestId = '67a36bd7-3392-4b07-b73e-c80da09e17ae';

describe('finding feedback requests', () => {
  it('accepts a correct label without a reason', () => {
    expect(parseFindingFeedbackRequest({
      requestId,
      assessment: 'correct',
    })).toEqual({ requestId, assessment: 'correct', reason: null });
  });

  it('accepts a bounded false-positive reason', () => {
    expect(parseFindingFeedbackRequest({
      requestId,
      assessment: 'false_positive',
      reason: 'incorrect_claim',
    })).toEqual({
      requestId,
      assessment: 'false_positive',
      reason: 'incorrect_claim',
    });
  });

  it('rejects free text and reasons on correct labels', () => {
    expect(() => parseFindingFeedbackRequest({
      requestId,
      assessment: 'false_positive',
      reason: 'the source contains a private value',
    })).toThrow();
    expect(() => parseFindingFeedbackRequest({
      requestId,
      assessment: 'correct',
      reason: 'other',
    })).toThrow();
  });
});
