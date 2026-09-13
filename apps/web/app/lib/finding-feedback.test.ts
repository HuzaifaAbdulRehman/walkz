import { describe, expect, it, vi } from 'vitest';

import { submitFindingFeedback } from './finding-feedback.js';

describe('finding feedback action', () => {
  it('sends one bounded label to the finding endpoint', async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));

    await submitFindingFeedback(request, {
      repositoryId: 'repo/id',
      reviewRunId: 'run/id',
      findingId: 'finding/id',
      requestId: '67a36bd7-3392-4b07-b73e-c80da09e17ae',
      assessment: 'false_positive',
    });

    expect(request).toHaveBeenCalledWith(
      '/api/repositories/repo%2Fid/reviews/run%2Fid/findings/finding%2Fid/feedback',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          requestId: '67a36bd7-3392-4b07-b73e-c80da09e17ae',
          assessment: 'false_positive',
          reason: null,
        }),
      }),
    );
  });

  it('rejects an unsuccessful save', async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 409 }));

    await expect(submitFindingFeedback(request, {
      repositoryId: 'repo',
      reviewRunId: 'run',
      findingId: 'finding',
      requestId: '67a36bd7-3392-4b07-b73e-c80da09e17ae',
      assessment: 'correct',
    })).rejects.toThrow('could not be saved');
  });
});
