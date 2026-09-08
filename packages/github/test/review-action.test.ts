import { describe, expect, it } from 'vitest';

import { shouldStartReview } from '../src/index.js';

describe('GitHub review triggers', () => {
  const policy = { manual: true, readyForReview: true, everyPush: false };

  it('accepts manual and ready-for-review triggers by default', () => {
    expect(shouldStartReview(policy, 'manual')).toBe(true);
    expect(shouldStartReview(policy, 'ready_for_review')).toBe(true);
    expect(shouldStartReview(policy, 'synchronize')).toBe(false);
  });

  it('requires explicit opt-in for every-push reviews', () => {
    expect(shouldStartReview({ ...policy, everyPush: true }, 'synchronize')).toBe(true);
  });
});
