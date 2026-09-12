import type { TransientPatchCandidate } from './patch-fixes';
import {
  patchDecisionPath,
  patchSuggestionPath,
} from './repository-api-paths';

interface ActionResponse {
  ok: boolean;
}

type ActionFetch = (path: string, init: RequestInit) => Promise<ActionResponse>;

export async function submitPatchDecision(
  fetchAction: ActionFetch,
  repositoryId: string,
  candidate: TransientPatchCandidate,
  decision: 'approved' | 'rejected',
): Promise<void> {
  if (decision === 'approved') {
    const publication = await fetchAction(
      patchSuggestionPath(repositoryId, candidate.proposalId),
      {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          candidate: {
            schemaVersion: candidate.schemaVersion,
            reviewRunId: candidate.reviewRunId,
            findingId: candidate.findingId,
            baseSha: candidate.baseSha,
            headSha: candidate.headSha,
            deliveryMode: candidate.deliveryMode,
            path: candidate.path,
            startLine: candidate.startLine,
            endLine: candidate.endLine,
            replacement: candidate.replacement,
            approvalRequired: candidate.approvalRequired,
            originalHash: candidate.originalHash,
            patchHash: candidate.patchHash,
          },
        }),
      },
    );
    if (!publication.ok) throw new Error('Patch suggestion publication failed.');
  }
  await submitStoredPatchDecision(
    fetchAction,
    repositoryId,
    candidate.proposalId,
    candidate.patchHash,
    candidate.headSha,
    decision,
  );
}

export async function submitStoredPatchDecision(
  fetchAction: ActionFetch,
  repositoryId: string,
  proposalId: string,
  patchHash: string,
  headSha: string,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const response = await fetchAction(
    patchDecisionPath(repositoryId, proposalId),
    {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedPatchHash: patchHash,
        expectedHeadSha: headSha,
        decision,
      }),
    },
  );
  if (!response.ok) throw new Error('Patch decision request failed.');
}
