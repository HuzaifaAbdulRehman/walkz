export interface DashboardReview {
  id: string;
  pullRequestId: string | null;
  baseSha: string;
  headSha: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

interface ReviewHistoryResponse {
  reviews: DashboardReview[];
}

function isReviewHistoryResponse(input: unknown): input is ReviewHistoryResponse {
  if (typeof input !== 'object' || input === null || !('reviews' in input)) return false;
  const reviews = (input as { reviews: unknown }).reviews;
  return Array.isArray(reviews) && reviews.every((review) => {
    if (typeof review !== 'object' || review === null) return false;
    const value = review as Record<string, unknown>;
    return typeof value.id === 'string' &&
      (typeof value.pullRequestId === 'string' || value.pullRequestId === null) &&
      typeof value.baseSha === 'string' && typeof value.headSha === 'string' &&
      typeof value.status === 'string' && typeof value.createdAt === 'string' &&
      (typeof value.completedAt === 'string' || value.completedAt === null);
  });
}

export async function loadDashboardReviews(
  apiUrl: string | undefined,
  repositoryId: string | undefined,
  cookie: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<DashboardReview[]> {
  if (apiUrl === undefined || apiUrl.trim().length === 0 || repositoryId === undefined || repositoryId.trim().length === 0) {
    return [];
  }
  const response = await fetcher(
    `${apiUrl.replace(/\/$/, '')}/api/repositories/${encodeURIComponent(repositoryId)}/reviews`,
    { cache: 'no-store', headers: cookie === undefined ? {} : { cookie } },
  );
  if (!response.ok) throw new Error(`Review history request failed with ${response.status}.`);
  const body: unknown = await response.json();
  if (!isReviewHistoryResponse(body)) throw new Error('Review history response was invalid.');
  return body.reviews;
}
