'use client';

import { useEffect, useRef, useState } from 'react';

import {
  parseDashboardPatchFixes,
  parsePatchProposalResponse,
  type DashboardPatchFix,
  type TransientPatchCandidate,
} from './lib/patch-fixes';
import {
  patchFixesPath,
  patchProposalPath,
} from './lib/repository-api-paths';
import {
  submitPatchDecision,
  submitStoredPatchDecision,
} from './lib/patch-fix-actions';

interface PatchFixControlsProps {
  repositoryId: string;
  reviewRunId: string;
  findingId: string;
}

type ViewState = 'idle' | 'loading' | 'generating' | 'deciding' | 'failed';
const activeStatuses = new Set(['queued', 'reproving']);

function statusMessage(fix: DashboardPatchFix): string {
  switch (fix.status) {
    case 'awaiting_approval':
      return fix.githubReference === null
        ? 'This proposal still needs your approval.'
        : 'The exact suggestion is on GitHub and still needs your approval.';
    case 'queued':
      return 'Approved. Reproof is queued.';
    case 'reproving':
      return 'Walkz is re-running the proof and regression checks.';
    case 'resolved':
      return 'The approved patch resolved the evidence.';
    case 'unresolved':
      return 'The approved patch did not resolve the evidence.';
    case 'inconclusive':
      return 'Reproof could not reach a safe conclusion.';
    case 'rejected':
      return 'You rejected this proposal. Nothing was published.';
    case 'failed':
      return 'The fix workflow failed closed. Nothing was reported as resolved.';
  }
}

export function PatchFixControls({ repositoryId, reviewRunId, findingId }: PatchFixControlsProps) {
  const [view, setView] = useState<ViewState>('loading');
  const [fix, setFix] = useState<DashboardPatchFix | null>(null);
  const [candidate, setCandidate] = useState<TransientPatchCandidate | null>(null);
  const controller = useRef<AbortController | null>(null);

  const load = async (signal?: AbortSignal) => {
    const response = await fetch(
      patchFixesPath(repositoryId, reviewRunId),
      { cache: 'no-store', ...(signal === undefined ? {} : { signal }) },
    );
    if (!response.ok) throw new Error('Patch fix status request failed.');
    const body: unknown = await response.json();
    const latest = parseDashboardPatchFixes(body)
      .find((item) => item.findingId === findingId) ?? null;
    setFix(latest);
    setView('idle');
    return latest;
  };

  useEffect(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    void load(current.signal).catch(() => {
      if (!current.signal.aborted) setView('failed');
    });
    return () => current.abort();
  }, [repositoryId, reviewRunId, findingId]);

  useEffect(() => {
    if (fix === null || !activeStatuses.has(fix.status)) return;
    const current = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!stopped) timer = setTimeout(() => void poll(), 3_000);
    };
    const poll = async () => {
      try {
        const latest = await load(current.signal);
        if (latest !== null && activeStatuses.has(latest.status)) schedule();
      } catch {
        if (!current.signal.aborted) {
          setView('failed');
          schedule();
        }
      }
    };
    schedule();
    return () => {
      stopped = true;
      current.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [fix?.proposalId, fix?.status, findingId, repositoryId, reviewRunId]);

  const generate = async () => {
    setView('generating');
    setCandidate(null);
    try {
      const response = await fetch(
        patchProposalPath(repositoryId, reviewRunId, findingId),
        { method: 'POST', cache: 'no-store' },
      );
      if (!response.ok) throw new Error('Patch generation request failed.');
      const proposal = parsePatchProposalResponse(await response.json());
      setCandidate(proposal.candidate);
      setFix(proposal.fix);
      setView('idle');
    } catch {
      setView('failed');
    }
  };

  const decide = async (decision: 'approved' | 'rejected') => {
    if (candidate === null) return;
    setView('deciding');
    try {
      await submitPatchDecision(fetch, repositoryId, candidate, decision);
      setCandidate(null);
      await load();
    } catch {
      setView('failed');
    }
  };

  const resumeApproval = async () => {
    if (fix === null || fix.githubReference === null) return;
    setView('deciding');
    try {
      await submitStoredPatchDecision(
        fetch,
        repositoryId,
        fix.proposalId,
        fix.patchHash,
        fix.headSha,
        'approved',
      );
      await load();
    } catch {
      setView('failed');
    }
  };

  return (
    <div className="patch-fix-controls">
      {fix === null ? null : (
        <div aria-live="polite" className={`patch-fix-status patch-fix-${fix.status}`}>
          <p>{statusMessage(fix)}</p>
          <p className="patch-fix-binding">
            Head {fix.headSha.slice(0, 7)} / patch {fix.patchHash.slice(0, 10)}
          </p>
          {fix.githubReference === null ? null : (
            <a href={fix.githubReference} rel="noreferrer" target="_blank">
              Open GitHub suggestion
            </a>
          )}
        </div>
      )}
      {candidate === null ? null : (
        <div className="patch-candidate">
          <p><strong>Proposed replacement.</strong> Review this exact text before approving.</p>
          <p className="patch-fix-binding">
            {candidate.path}:{candidate.startLine}-{candidate.endLine}
          </p>
          <pre>{candidate.replacement}</pre>
          <p className="patch-privacy-note">
            This text is kept only in this page. Walkz stores its hash, not the patch text.
          </p>
          <div className="patch-fix-actions">
            <button
              className="primary-action"
              disabled={view === 'deciding'}
              onClick={() => void decide('approved')}
              type="button"
            >
              {view === 'deciding' ? 'Saving...' : 'Approve and re-prove'}
            </button>
            <button
              className="secondary-action"
              disabled={view === 'deciding'}
              onClick={() => void decide('rejected')}
              type="button"
            >
              Reject
            </button>
          </div>
        </div>
      )}
      {candidate === null && fix?.status === 'awaiting_approval' &&
        fix.githubReference !== null ? (
          <button
            className="primary-action"
            disabled={view === 'deciding'}
            onClick={() => void resumeApproval()}
            type="button"
          >
            {view === 'deciding' ? 'Approving...' : 'Resume approval and re-prove'}
          </button>
        ) : null}
      {candidate !== null || (fix !== null && activeStatuses.has(fix.status)) ||
        fix?.status === 'resolved' || fix?.status === 'unresolved' ||
        fix?.status === 'inconclusive' || fix?.status === 'rejected' ||
        (fix?.status === 'awaiting_approval' && fix.githubReference !== null) ? null : (
          <button
            className="secondary-action"
            disabled={view === 'generating' || view === 'loading'}
            onClick={() => void generate()}
            type="button"
          >
            {view === 'generating'
              ? 'Generating...'
              : fix?.status === 'awaiting_approval'
                ? 'Load proposal again'
                : 'Propose a fix'}
          </button>
        )}
      {view === 'failed' ? (
        <p className="patch-fix-error" role="alert">
          The fix action could not be completed. Refresh the status and try again safely.
        </p>
      ) : null}
    </div>
  );
}
