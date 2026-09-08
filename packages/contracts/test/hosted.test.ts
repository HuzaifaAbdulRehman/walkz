import { describe, expect, it } from 'vitest';

import {
  canTransitionReviewRun,
  isTerminalReviewRunStatus,
  parseGithubId,
  parseHostedReviewRun,
} from '../src/index.js';

const baseRun = {
  id: '3d963b52-8203-4ba6-bcac-15bf132371f0',
  repositoryId: 'b788e8de-f132-4844-99da-bd8fc1c409cf',
  pullRequestId: null,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  configHash: 'c'.repeat(64),
  provider: 'groq',
  model: 'model-id',
  promptVersion: 'v1',
  status: 'queued',
} as const;

describe('hosted contracts', () => {
  it('preserves GitHub IDs that exceed JavaScript safe integers', () => {
    expect(parseGithubId('9223372036854775807')).toBe(
      '9223372036854775807',
    );
    expect(() => parseGithubId('0')).toThrow();
    expect(() => parseGithubId('9223372036854775808')).toThrow(
      'PostgreSQL BIGINT',
    );
  });

  it('requires immutable run inputs to identify distinct revisions', () => {
    expect(parseHostedReviewRun(baseRun)).toEqual(baseRun);
    expect(() =>
      parseHostedReviewRun({ ...baseRun, headSha: baseRun.baseSha }),
    ).toThrow('distinct revisions');
  });

  it('does not reactivate a terminal run', () => {
    expect(isTerminalReviewRunStatus('completed')).toBe(true);
    expect(canTransitionReviewRun('completed', 'reviewing')).toBe(false);
    expect(canTransitionReviewRun('reviewing', 'completed')).toBe(true);
    expect(canTransitionReviewRun('cancelled', 'cancelled')).toBe(true);
  });
});
