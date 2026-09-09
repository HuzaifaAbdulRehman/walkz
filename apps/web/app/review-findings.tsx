'use client';

import { useEffect, useRef, useState } from 'react';

import {
  parseDashboardFindings,
  type DashboardFinding,
} from './lib/reviews';

interface ReviewFindingsProps {
  reviewRunId: string;
}

type FindingState =
  | { status: 'idle'; findings: DashboardFinding[] }
  | { status: 'loading'; findings: DashboardFinding[] }
  | { status: 'ready'; findings: DashboardFinding[] }
  | { status: 'failed'; findings: DashboardFinding[] };

function locationLabel(finding: DashboardFinding): string {
  if (finding.path === null || finding.startLine === null) return 'Location unavailable';
  const end = finding.endLine === null || finding.endLine === finding.startLine
    ? ''
    : `-${finding.endLine}`;
  return `${finding.path}:${finding.startLine}${end}`;
}

function evidenceLabel(level: DashboardFinding['evidenceLevel']): string {
  if (level === 'VERIFIED') return 'Verified evidence';
  if (level === 'SUPPORTED') return 'Supported evidence';
  return 'Unverified';
}

export function ReviewFindings({ reviewRunId }: ReviewFindingsProps) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<FindingState>({ status: 'idle', findings: [] });
  const controller = useRef<AbortController | null>(null);
  const panelId = `review-findings-${reviewRunId}`;

  useEffect(() => () => controller.current?.abort(), []);

  const load = async () => {
    controller.current?.abort();
    controller.current = new AbortController();
    setExpanded(true);
    setState((current) => ({ status: 'loading', findings: current.findings }));
    try {
      const response = await fetch(
        `/api/reviews/${encodeURIComponent(reviewRunId)}/findings`,
        { cache: 'no-store', signal: controller.current.signal },
      );
      if (!response.ok) throw new Error('Finding details request failed.');
      const body: unknown = await response.json();
      setState({ status: 'ready', findings: parseDashboardFindings(body) });
    } catch {
      if (controller.current.signal.aborted) return;
      setState((current) => ({ status: 'failed', findings: current.findings }));
    }
  };

  const toggle = () => {
    if (state.status === 'idle') {
      void load();
      return;
    }
    setExpanded((current) => !current);
  };

  return (
    <div className="finding-disclosure">
      <button
        aria-controls={panelId}
        aria-expanded={expanded}
        className="finding-toggle"
        onClick={state.status === 'failed' ? () => void load() : toggle}
        type="button"
      >
        {state.status === 'failed'
          ? 'Retry finding details'
          : expanded
            ? 'Hide finding details'
            : 'Show finding details'}
      </button>
      {!expanded ? null : (
        <div className="finding-panel" id={panelId}>
          {state.status === 'loading' ? (
            <p aria-live="polite" className="finding-message">Loading finding details.</p>
          ) : state.status === 'failed' ? (
            <p role="alert" className="finding-message">
              Finding details are unavailable. Try again.
            </p>
          ) : state.findings.length === 0 ? (
            <p className="finding-message">No findings were recorded for this review.</p>
          ) : (
            <ol className="finding-list">
              {state.findings.map((finding) => (
                <li className="finding-item" key={finding.fingerprint}>
                  <div className="finding-heading">
                    <span className={`evidence evidence-${finding.evidenceLevel.toLowerCase()}`}>
                      {evidenceLabel(finding.evidenceLevel)}
                    </span>
                    <span className="finding-location">{locationLabel(finding)}</span>
                  </div>
                  <h4>{finding.claim ?? finding.summary}</h4>
                  {finding.failureMechanism === null ? null : (
                    <p><strong>How it fails.</strong> {finding.failureMechanism}</p>
                  )}
                  {finding.suggestedProof === null ? null : (
                    <p><strong>How to check it.</strong> {finding.suggestedProof}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
