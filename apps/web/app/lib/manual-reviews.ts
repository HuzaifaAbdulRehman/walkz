const maximumPullRequestNumber = 2_147_483_647;

export const manualReviewQueuedEvent = 'walkz:review-queued';

export interface ManualReviewAcceptance {
  reviewRunId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parsePullRequestNumber(value: string): number | null {
  const normalized = value.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed <= maximumPullRequestNumber
    ? parsed
    : null;
}

export function parseManualReviewAcceptance(input: unknown): ManualReviewAcceptance {
  if (
    !isRecord(input) ||
    Object.keys(input).length !== 1 ||
    typeof input.reviewRunId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.reviewRunId)
  ) {
    throw new Error('Manual review response was invalid.');
  }
  return { reviewRunId: input.reviewRunId };
}

export function manualReviewErrorMessage(status: number, input: unknown): string {
  const code = isRecord(input) && typeof input.error === 'string' ? input.error : '';
  if (status === 401 || code === 'authentication_required') {
    return 'Your session expired. Sign in again.';
  }
  if (status === 403 || code === 'repository_forbidden') {
    return 'Walkz no longer has access to this repository.';
  }
  if (code === 'invalid_idempotency_key') {
    return 'Walkz could not start the review. Refresh the page and try again.';
  }
  if (code === 'invalid_request') {
    return 'Enter the number of an open pull request.';
  }
  if (status >= 500) {
    return 'Walkz could not confirm whether the review started. Try again safely.';
  }
  return 'Walkz could not start the review. Try again.';
}

export function shouldReuseManualReviewRequestId(status: number): boolean {
  return status >= 500;
}
