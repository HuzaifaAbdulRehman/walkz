function segment(value: string): string {
  return encodeURIComponent(value);
}

export function repositoryReviewsPath(repositoryId: string): string {
  return `/api/repositories/${segment(repositoryId)}/reviews`;
}

export function reviewFindingsPath(repositoryId: string, reviewRunId: string): string {
  return `${repositoryReviewsPath(repositoryId)}/${segment(reviewRunId)}/findings`;
}

export function patchFixesPath(repositoryId: string, reviewRunId: string): string {
  return `${repositoryReviewsPath(repositoryId)}/${segment(reviewRunId)}/patch-fixes`;
}

export function patchProposalPath(
  repositoryId: string,
  reviewRunId: string,
  findingId: string,
): string {
  return `${reviewFindingsPath(repositoryId, reviewRunId)}/${segment(findingId)}/patch-proposals`;
}

export function findingFeedbackPath(
  repositoryId: string,
  reviewRunId: string,
  findingId: string,
): string {
  return `${reviewFindingsPath(repositoryId, reviewRunId)}/${segment(findingId)}/feedback`;
}

export function patchDecisionPath(repositoryId: string, proposalId: string): string {
  return `/api/repositories/${segment(repositoryId)}/patch-proposals/${segment(proposalId)}/decision`;
}

export function patchSuggestionPath(repositoryId: string, proposalId: string): string {
  return `/api/repositories/${segment(repositoryId)}/patch-proposals/${segment(proposalId)}/publish-suggestion`;
}
