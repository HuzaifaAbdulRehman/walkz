import { describe, expect, it } from 'vitest';

import {
  canTransitionPatchApproval,
  isPatchProposalActionable,
  parsePatchApprovalRequest,
  parsePatchProposal,
} from '../src/index.js';

const pendingProposal = {
  id: '34e04c9f-bf3a-4ab9-9c81-902ad75d0110',
  reviewRunId: 'f931b8c5-f267-4b1b-8cb4-273695d4448e',
  findingId: '15d3e79e-02eb-42c3-91c5-0e48c4b5bf68',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  patchHash: 'c'.repeat(64),
  deliveryMode: 'suggestion',
  approvalStatus: 'pending',
  githubReference: null,
  decidedByUserId: null,
  decidedAt: null,
  staleAt: null,
  createdAt: new Date('2026-09-11T00:00:00.000Z'),
  updatedAt: new Date('2026-09-11T00:00:00.000Z'),
} as const;

describe('patch proposal contracts', () => {
  it('accepts a pending proposal without private patch content', () => {
    expect(parsePatchProposal(pendingProposal)).toEqual(pendingProposal);
    expect(() =>
      parsePatchProposal({ ...pendingProposal, patchText: 'private source' }),
    ).toThrow();
  });

  it('binds an approval request to the hash and exact head', () => {
    const request = {
      proposalId: pendingProposal.id,
      expectedPatchHash: pendingProposal.patchHash,
      expectedHeadSha: pendingProposal.headSha,
    };
    expect(parsePatchApprovalRequest(request)).toEqual(request);
    expect(() => parsePatchApprovalRequest({
      ...request,
      expectedHeadSha: 'not-a-sha',
    })).toThrow();
  });

  it('requires decision metadata and matching GitHub references', () => {
    expect(() => parsePatchProposal({
      ...pendingProposal,
      approvalStatus: 'approved',
    })).toThrow('decision metadata');
    expect(() => parsePatchProposal({
      ...pendingProposal,
      approvalStatus: 'approved',
      decidedByUserId: '185e34e7-75ad-4903-b31c-ec068f12ada0',
      decidedAt: new Date('2026-09-11T00:01:00.000Z'),
      githubReference: { kind: 'fix_branch', value: 'refs/heads/walkz/fix' },
    })).toThrow('delivery mode');
  });

  it('does not reopen a final decision', () => {
    expect(canTransitionPatchApproval('pending', 'approved')).toBe(true);
    expect(canTransitionPatchApproval('rejected', 'approved')).toBe(false);
    expect(canTransitionPatchApproval('approved', 'rejected')).toBe(false);
  });

  it('makes a stale proposal non-actionable without erasing its decision', () => {
    expect(isPatchProposalActionable(pendingProposal)).toBe(true);
    expect(isPatchProposalActionable({
      ...pendingProposal,
      staleAt: new Date('2026-09-11T00:02:00.000Z'),
    })).toBe(false);
  });

  it('rejects timestamps that predate proposal creation', () => {
    expect(() => parsePatchProposal({
      ...pendingProposal,
      updatedAt: new Date('2026-09-10T23:59:59.000Z'),
    })).toThrow('Patch proposal timestamps must not precede creation.');
  });
});
