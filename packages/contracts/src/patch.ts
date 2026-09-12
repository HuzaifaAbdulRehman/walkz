import { z } from 'zod';

const sha1Schema = z.string().regex(/^[a-f0-9]{40}$/i);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);

export const patchDeliveryModeSchema = z.enum(['suggestion', 'fix_branch']);

export const patchApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
]);

export const patchGithubReferenceSchema = z
  .object({
    kind: z.enum(['review_comment', 'fix_branch']),
    value: z.string().trim().min(1).max(512),
  })
  .strict();

export const patchProposalSchema = z
  .object({
    id: z.uuid(),
    reviewRunId: z.uuid(),
    findingId: z.uuid(),
    baseSha: sha1Schema,
    headSha: sha1Schema,
    patchHash: sha256Schema,
    deliveryMode: patchDeliveryModeSchema,
    approvalStatus: patchApprovalStatusSchema,
    githubReference: patchGithubReferenceSchema.nullable(),
    decidedByUserId: z.uuid().nullable(),
    decidedAt: z.coerce.date().nullable(),
    staleAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict()
  .refine((proposal) => proposal.baseSha !== proposal.headSha, {
    message: 'Patch proposals must target a changed head revision.',
    path: ['headSha'],
  })
  .refine(
    (proposal) => {
      if (proposal.approvalStatus === 'pending') {
        return proposal.decidedByUserId === null && proposal.decidedAt === null;
      }
      return proposal.decidedByUserId !== null && proposal.decidedAt !== null;
    },
    {
      message: 'Patch proposal decision metadata does not match its approval state.',
      path: ['approvalStatus'],
    },
  )
  .refine(
    (proposal) =>
      proposal.githubReference === null ||
      proposal.approvalStatus !== 'rejected',
    {
      message: 'Rejected patch proposals may not have a GitHub reference.',
      path: ['githubReference'],
    },
  )
  .refine(
    (proposal) =>
      proposal.githubReference === null ||
      (proposal.deliveryMode === 'suggestion' &&
        proposal.githubReference.kind === 'review_comment') ||
      (proposal.deliveryMode === 'fix_branch' &&
        proposal.githubReference.kind === 'fix_branch'),
    {
      message: 'GitHub references must match the patch delivery mode.',
      path: ['githubReference'],
    },
  )
  .refine(
    (proposal) =>
      proposal.updatedAt >= proposal.createdAt &&
      (proposal.decidedAt === null || proposal.decidedAt >= proposal.createdAt) &&
      (proposal.staleAt === null || proposal.staleAt >= proposal.createdAt),
    {
      message: 'Patch proposal timestamps must not precede creation.',
      path: ['updatedAt'],
    },
  );

export const patchApprovalRequestSchema = z
  .object({
    proposalId: z.uuid(),
    expectedPatchHash: sha256Schema,
    expectedHeadSha: sha1Schema,
  })
  .strict();

export type PatchApprovalRequest = z.infer<typeof patchApprovalRequestSchema>;
export type PatchApprovalStatus = z.infer<typeof patchApprovalStatusSchema>;
export type PatchDeliveryMode = z.infer<typeof patchDeliveryModeSchema>;
export type PatchGithubReference = z.infer<typeof patchGithubReferenceSchema>;
export type PatchProposal = z.infer<typeof patchProposalSchema>;

const patchApprovalTransitions: Readonly<
  Record<PatchApprovalStatus, ReadonlySet<PatchApprovalStatus>>
> = {
  pending: new Set(['pending', 'approved', 'rejected']),
  approved: new Set(['approved']),
  rejected: new Set(['rejected']),
};

export function canTransitionPatchApproval(
  from: PatchApprovalStatus,
  to: PatchApprovalStatus,
): boolean {
  return patchApprovalTransitions[from].has(to);
}

export function isPatchProposalActionable(proposal: PatchProposal): boolean {
  return proposal.approvalStatus === 'pending' && proposal.staleAt === null;
}

export function parsePatchApprovalRequest(
  input: unknown,
): PatchApprovalRequest {
  return patchApprovalRequestSchema.parse(input);
}

export function parsePatchProposal(input: unknown): PatchProposal {
  return patchProposalSchema.parse(input);
}
