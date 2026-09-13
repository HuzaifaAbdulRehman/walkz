import { describe, expect, it } from 'vitest';

import { parseModelChallengeResponse } from '../src/index.js';

const fingerprint = 'a'.repeat(64);

describe('parseModelChallengeResponse', () => {
  it('accepts a bounded decision tied to a finding fingerprint', () => {
    expect(parseModelChallengeResponse({
      decisions: [{
        findingFingerprint: fingerprint.toUpperCase(),
        verdict: 'uphold',
        rationale: 'The failing check supports the reported mechanism.',
      }],
    })).toEqual({
      decisions: [{
        findingFingerprint: fingerprint,
        verdict: 'uphold',
        rationale: 'The failing check supports the reported mechanism.',
      }],
    });
  });

  it('rejects duplicate, unknown-shaped, and unbounded decisions', () => {
    const decision = {
      findingFingerprint: fingerprint,
      verdict: 'dispute',
      rationale: 'The claimed failure does not follow from this change.',
    };

    expect(() => parseModelChallengeResponse({
      decisions: [decision, decision],
    })).toThrow(/unique/i);
    expect(() => parseModelChallengeResponse({
      decisions: [{ ...decision, source: 'private code' }],
    })).toThrow();
    expect(() => parseModelChallengeResponse({ decisions: [] })).toThrow();
  });

  it('rejects malformed JSON', () => {
    expect(() => parseModelChallengeResponse('{not json')).toThrow(
      /not valid JSON/i,
    );
  });
});
