import { describe, expect, it } from 'vitest';

import {
  patchDecisionPath,
  patchFixesPath,
  patchProposalPath,
  repositoryReviewsPath,
  reviewFindingsPath,
} from './repository-api-paths.js';

describe('repository API paths', () => {
  it('binds live review requests to the selected repository', () => {
    expect(repositoryReviewsPath('repo/id')).toBe('/api/repositories/repo%2Fid/reviews');
    expect(reviewFindingsPath('repo/id', 'run/id')).toBe(
      '/api/repositories/repo%2Fid/reviews/run%2Fid/findings',
    );
    expect(patchFixesPath('repo/id', 'run/id')).toBe(
      '/api/repositories/repo%2Fid/reviews/run%2Fid/patch-fixes',
    );
    expect(patchProposalPath('repo/id', 'run/id', 'finding/id')).toBe(
      '/api/repositories/repo%2Fid/reviews/run%2Fid/findings/finding%2Fid/patch-proposals',
    );
    expect(patchDecisionPath('repo/id', 'proposal/id')).toBe(
      '/api/repositories/repo%2Fid/patch-proposals/proposal%2Fid/decision',
    );
  });
});
