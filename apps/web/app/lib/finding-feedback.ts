import { findingFeedbackPath } from './repository-api-paths';

export type FindingFeedbackAssessment = 'correct' | 'false_positive';

export async function submitFindingFeedback(
  request: typeof fetch,
  input: {
    repositoryId: string;
    reviewRunId: string;
    findingId: string;
    requestId: string;
    assessment: FindingFeedbackAssessment;
  },
): Promise<void> {
  const response = await request(
    findingFeedbackPath(input.repositoryId, input.reviewRunId, input.findingId),
    {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: input.requestId,
        assessment: input.assessment,
        reason: null,
      }),
    },
  );
  if (!response.ok) throw new Error('Finding feedback could not be saved.');
}
