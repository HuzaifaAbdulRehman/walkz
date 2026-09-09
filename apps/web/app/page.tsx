import { cookies } from 'next/headers';

import { ConfigurationHistory } from './configuration-history';
import {
  loadDashboardConfigurations,
  loadDashboardReviews,
  type DashboardConfiguration,
  type DashboardReview,
} from './lib/reviews';
import { ReviewHistory } from './review-history';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = (await cookies()).get('walkz_session')?.value;
  const cookieHeader = session === undefined ? undefined : `walkz_session=${encodeURIComponent(session)}`;
  const [reviewHistory, configurationHistory] = await Promise.allSettled([
    loadDashboardReviews(
      process.env.WALKZ_API_URL,
      process.env.WALKZ_REPOSITORY_ID,
      cookieHeader || undefined,
    ),
    loadDashboardConfigurations(
      process.env.WALKZ_API_URL,
      process.env.WALKZ_REPOSITORY_ID,
      cookieHeader || undefined,
    ),
  ]);
  const reviews: DashboardReview[] = reviewHistory.status === 'fulfilled' ? reviewHistory.value : [];
  const configurations: DashboardConfiguration[] = configurationHistory.status === 'fulfilled'
    ? configurationHistory.value
    : [];
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
        {reviewHistory.status === 'rejected' ? (
          <p className="empty-state">Review history is temporarily unavailable. Try again later.</p>
        ) : (
          <ReviewHistory initialReviews={reviews} />
        )}
      </section>
      <section aria-labelledby="configuration-history">
        <div className="section-heading">
          <h2 id="configuration-history">Configuration history</h2>
          <span className="badge">Metadata only</span>
        </div>
        <ConfigurationHistory
          configurations={configurations}
          unavailable={configurationHistory.status === 'rejected'}
        />
      </section>
    </main>
  );
}
