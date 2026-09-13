'use client';

import { useRef, useState } from 'react';

import {
  submitFindingFeedback,
  type FindingFeedbackAssessment,
} from './lib/finding-feedback';

interface FindingFeedbackControlsProps {
  repositoryId: string;
  reviewRunId: string;
  findingId: string;
}

type FeedbackState = 'idle' | 'saving' | 'saved' | 'failed';

export function FindingFeedbackControls({
  repositoryId,
  reviewRunId,
  findingId,
}: FindingFeedbackControlsProps) {
  const [state, setState] = useState<FeedbackState>('idle');
  const [savedAssessment, setSavedAssessment] =
    useState<FindingFeedbackAssessment | null>(null);
  const pending = useRef<{
    assessment: FindingFeedbackAssessment;
    requestId: string;
  } | null>(null);

  const submit = async (assessment: FindingFeedbackAssessment) => {
    const requestId = pending.current?.assessment === assessment
      ? pending.current.requestId
      : globalThis.crypto.randomUUID();
    pending.current = { assessment, requestId };
    setState('saving');
    try {
      await submitFindingFeedback(fetch, {
        repositoryId,
        reviewRunId,
        findingId,
        requestId,
        assessment,
      });
      pending.current = null;
      setSavedAssessment(assessment);
      setState('saved');
    } catch {
      setState('failed');
    }
  };

  if (state === 'saved') {
    return (
      <p aria-live="polite" className="finding-feedback-message">
        Feedback recorded as {savedAssessment === 'correct' ? 'correct' : 'false positive'}.
        It will not change this review.
      </p>
    );
  }

  return (
    <div className="finding-feedback-controls">
      <p>Was this finding right?</p>
      <div className="finding-feedback-actions">
        <button
          className="secondary-action"
          disabled={state === 'saving'}
          onClick={() => void submit('correct')}
          type="button"
        >
          Correct
        </button>
        <button
          className="secondary-action"
          disabled={state === 'saving'}
          onClick={() => void submit('false_positive')}
          type="button"
        >
          False positive
        </button>
      </div>
      {state === 'saving' ? (
        <p aria-live="polite" className="finding-feedback-message">Saving feedback.</p>
      ) : state === 'failed' ? (
        <p role="alert" className="finding-feedback-error">
          Feedback was not saved. Choose the same answer to retry.
        </p>
      ) : null}
    </div>
  );
}
