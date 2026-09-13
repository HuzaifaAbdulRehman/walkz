import { describe, expect, it } from 'vitest';

import { resolveBuildId } from './build-id.cjs';

describe('web release build identity', () => {
  it('binds production output to the full source revision', () => {
    const revision = 'a'.repeat(40);
    expect(resolveBuildId(revision)).toBe(revision);
  });

  it('keeps local builds explicit and rejects ambiguous identities', () => {
    expect(resolveBuildId()).toBe('development');
    expect(resolveBuildId('development')).toBe('development');
    expect(() => resolveBuildId('main')).toThrow(/full lowercase Git SHA/);
  });
});
