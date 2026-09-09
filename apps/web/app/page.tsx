import { cookies } from 'next/headers';

import { loadDashboardReviews, type DashboardReview } from './lib/reviews';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = (await cookies()).get('walkz_session')?.value;
  const cookieHeader = session === undefined ? undefined : `walkz_session=${encodeURIComponent(session)}`;
  let reviews: DashboardReview[] = [];
  let historyUnavailable = false;
  try {
    reviews = await loadDashboardReviews(
      process.env.WALKZ_API_URL,
      process.env.WALKZ_REPOSITORY_ID,
      cookieHeader || undefined,
    );
  } catch {
    historyUnavailable = true;
  }
  return (
    <main className="shell">
      <header className="hero">
        <p className="eyebrow">WALKZ / REVIEW DASHBOARD</p>
        <h1>Evidence before merge.</h1>
        <p className="lede">Walkz separates model suggestions from deterministic review evidence.</p>
      </header>
      <section aria-labelledby="recent-reviews">
        <div className="section-heading">
          <h2 id="recent-reviews">Recent reviews</h2>
          <span className="badge">Read only</span>
        </div>
        {historyUnavailable ? (
          <p className="empty-state">Review history is temporarily unavailable. Try again later.</p>
        ) : reviews.length === 0 ? (
          <p className="empty-state">No review history is available for this repository yet.</p>
        ) : (
          <div className="review-list">
            {reviews.map((review) => (
              <article className="review-card" key={review.id}>
                <div>
                  <p className="repository">Pull request {review.pullRequestId ?? 'not linked'}</p>
                  <h3>{review.status}</h3>
                  <p className="detail">
                    {review.headSha.slice(0, 7)} against {review.baseSha.slice(0, 7)}
                  </p>
                </div>
                <span className={`status status-${review.status.toLowerCase()}`}>{review.status}</span>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
