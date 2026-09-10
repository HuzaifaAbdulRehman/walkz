'use client';

import { useRef, useState, type FormEvent } from 'react';

import {
  manualReviewErrorMessage,
  manualReviewQueuedEvent,
  parseManualReviewAcceptance,
  parsePullRequestNumber,
  shouldReuseManualReviewRequestId,
} from './lib/manual-reviews';

interface ManualReviewFormProps {
  repositoryId: string;
}

interface FormFeedback {
  error: boolean;
  message: string;
}

async function readResponseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function ManualReviewForm({ repositoryId }: ManualReviewFormProps) {
  const [pullRequestNumber, setPullRequestNumber] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<FormFeedback | null>(null);
  const requestId = useRef<string | null>(null);

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const parsedNumber = parsePullRequestNumber(pullRequestNumber);
    if (parsedNumber === null) {
      setFeedback({ error: true, message: 'Enter the number of an open pull request.' });
      return;
    }

    const currentRequestId = requestId.current ?? crypto.randomUUID();
    requestId.current = currentRequestId;
    setSubmitting(true);
    setFeedback(null);
    try {
      const response = await fetch(
        `/api/repositories/${encodeURIComponent(repositoryId)}/pull-requests/${parsedNumber}/reviews`,
        {
          method: 'POST',
          headers: { 'idempotency-key': currentRequestId },
        },
      );
      const body = await readResponseBody(response);
      if (!response.ok) {
        if (!shouldReuseManualReviewRequestId(response.status)) requestId.current = null;
        setFeedback({
          error: true,
          message: manualReviewErrorMessage(response.status, body),
        });
        return;
      }
      parseManualReviewAcceptance(body);
      requestId.current = null;
      setFeedback({
        error: false,
        message: `Review queued for pull request #${parsedNumber}.`,
      });
      window.dispatchEvent(new Event(manualReviewQueuedEvent));
    } catch {
      setFeedback({
        error: true,
        message: 'Walkz could not confirm whether the review started. Try again safely.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="manual-review">
      <div className="section-heading">
        <h2 id="manual-review">Run a review</h2>
        <span className="badge">Manual</span>
      </div>
      <div className="setup-card manual-review-card">
        <p className="setup-copy">
          Enter an open pull request number. Walkz will inspect its current base and head
          commits and publish the result as a GitHub check.
        </p>
        <form className="manual-review-form" onSubmit={submitReview}>
          <label htmlFor="pull-request-number">Pull request number</label>
          <div className="manual-review-controls">
            <input
              id="pull-request-number"
              name="pull-request-number"
              type="number"
              inputMode="numeric"
              min="1"
              max="2147483647"
              step="1"
              required
              value={pullRequestNumber}
              disabled={submitting}
              onChange={(event) => {
                setPullRequestNumber(event.currentTarget.value);
                setFeedback(null);
                requestId.current = null;
              }}
            />
            <button
              className="primary-action"
              type="submit"
              disabled={submitting || pullRequestNumber.length === 0}
              data-busy={submitting}
            >
              {submitting ? 'Starting...' : 'Run review'}
            </button>
          </div>
          {feedback === null ? null : (
            <p
              className={`form-message ${feedback.error ? 'form-error' : 'form-success'}`}
              role={feedback.error ? 'alert' : 'status'}
            >
              {feedback.message}
            </p>
          )}
        </form>
      </div>
    </section>
  );
}
