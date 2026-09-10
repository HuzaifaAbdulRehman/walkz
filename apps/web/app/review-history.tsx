'use client';

import { useEffect, useState } from 'react';

import {
  parseDashboardReviewHistory,
  type DashboardReview,
} from './lib/reviews';
import { manualReviewQueuedEvent } from './lib/manual-reviews';
import { ReviewFindings } from './review-findings';

const refreshIntervalMs = 15_000;

function formatStatus(status: string): string {
  return status.split('_').map((word) => word[0]?.toUpperCase() + word.slice(1)).join(' ');
}

function verdictLabel(review: DashboardReview): string {
  return review.verdict ?? 'IN PROGRESS';
}

export function ReviewHistory({ initialReviews }: { initialReviews: DashboardReview[] }) {
  const [reviews, setReviews] = useState(initialReviews);
  const [refreshState, setRefreshState] = useState<'current' | 'updating' | 'unavailable'>('current');

  useEffect(() => {
    setReviews(initialReviews);
  }, [initialReviews]);

  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let refreshGeneration = 0;

    const refresh = async () => {
      const generation = ++refreshGeneration;
      controller?.abort();
      const refreshController = new AbortController();
      controller = refreshController;
      setRefreshState('updating');
      try {
        const response = await fetch('/api/reviews', {
          cache: 'no-store',
          signal: refreshController.signal,
        });
        if (!response.ok) throw new Error('Review history refresh failed.');
        const body: unknown = await response.json();
        const nextReviews = parseDashboardReviewHistory(body);
        if (!active) return;
        setReviews(nextReviews);
        setRefreshState('current');
      } catch {
        if (!active || refreshController.signal.aborted) return;
        setRefreshState('unavailable');
      } finally {
        if (active && generation === refreshGeneration) {
          timeout = setTimeout(refresh, refreshIntervalMs);
        }
      }
    };

    const refreshAfterQueue = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      void refresh();
    };

    timeout = setTimeout(refresh, refreshIntervalMs);
    window.addEventListener(manualReviewQueuedEvent, refreshAfterQueue);
    return () => {
      active = false;
      window.removeEventListener(manualReviewQueuedEvent, refreshAfterQueue);
      controller?.abort();
      if (timeout !== undefined) clearTimeout(timeout);
    };
  }, []);

  return (
    <>
      <p aria-live="polite" className="live-status">
        {refreshState === 'updating'
          ? 'Updating review history.'
          : refreshState === 'unavailable'
            ? 'Live updates are unavailable. Showing the last confirmed history.'
            : 'Live updates are on.'}
      </p>
      {reviews.length === 0 ? (
        <p className="empty-state">No review history is available for this repository yet.</p>
      ) : (
        <div className="review-list">
          {reviews.map((review) => (
            <article className="review-card" key={review.id}>
              <div className="review-card-header">
                <div>
                  <p className="repository">Pull request {review.pullRequestId ?? 'not linked'}</p>
                  <h3>{verdictLabel(review)}</h3>
                  <p className="detail">
                    {formatStatus(review.status)} / {review.headSha.slice(0, 7)} against {review.baseSha.slice(0, 7)}
                  </p>
                  {review.resultSummary === null ? null : <p className="review-summary">{review.resultSummary}</p>}
                </div>
                <span className={`status status-${review.verdict?.toLowerCase() ?? 'active'}`}>
                  {verdictLabel(review)}
                </span>
              </div>
              <ReviewFindings reviewRunId={review.id} />
            </article>
          ))}
        </div>
      )}
    </>
  );
}
