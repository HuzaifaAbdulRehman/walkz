export interface DashboardReview {
  id: string;
  pullRequestId: string | null;
  baseSha: string;
  headSha: string;
  status: string;
  verdict: 'SHIP' | 'FIX' | 'HUMAN' | 'INCONCLUSIVE' | 'ERROR' | null;
  resultSummary: string | null;
  createdAt: string;
  completedAt: string | null;
}

const verdicts = new Set<NonNullable<DashboardReview['verdict']>>([
  'SHIP', 'FIX', 'HUMAN', 'INCONCLUSIVE', 'ERROR',
]);

function isDashboardVerdict(value: string): value is NonNullable<DashboardReview['verdict']> {
  return verdicts.has(value as NonNullable<DashboardReview['verdict']>);
}

function parseDashboardReview(input: unknown): DashboardReview | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = input as Record<string, unknown>;
  if (
    typeof value.id !== 'string' ||
    (typeof value.pullRequestId !== 'string' && value.pullRequestId !== null) ||
    typeof value.baseSha !== 'string' || typeof value.headSha !== 'string' ||
    typeof value.status !== 'string' ||
    (typeof value.verdict !== 'string' && value.verdict !== null) ||
    (typeof value.resultSummary !== 'string' && value.resultSummary !== null) ||
    typeof value.createdAt !== 'string' ||
    (typeof value.completedAt !== 'string' && value.completedAt !== null)
  ) return null;
  if (value.status.trim().length === 0 || (value.verdict !== null && !isDashboardVerdict(value.verdict))) {
    return null;
  }
  return {
    id: value.id,
    pullRequestId: value.pullRequestId,
    baseSha: value.baseSha,
    headSha: value.headSha,
    status: value.status,
    verdict: value.verdict === null ? null : value.verdict as NonNullable<DashboardReview['verdict']>,
    resultSummary: value.resultSummary,
    createdAt: value.createdAt,
    completedAt: value.completedAt,
  };
}

export function parseDashboardReviewHistory(input: unknown): DashboardReview[] {
  if (typeof input !== 'object' || input === null || !('reviews' in input)) {
    throw new Error('Review history response was invalid.');
  }
  const reviews = (input as { reviews: unknown }).reviews;
  if (!Array.isArray(reviews)) throw new Error('Review history response was invalid.');
  const parsed: DashboardReview[] = [];
  for (const review of reviews) {
    const mapped = parseDashboardReview(review);
    if (mapped === null) throw new Error('Review history response was invalid.');
    parsed.push(mapped);
  }
  return parsed;
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
  return parseDashboardReviewHistory(body);
}
