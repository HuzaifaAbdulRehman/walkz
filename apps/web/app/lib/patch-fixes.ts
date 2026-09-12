export type PatchFixStatus =
  | 'awaiting_approval'
  | 'queued'
  | 'reproving'
  | 'resolved'
  | 'unresolved'
  | 'inconclusive'
  | 'rejected'
  | 'failed';

export interface DashboardPatchFix {
  proposalId: string;
  findingId: string;
  headSha: string;
  patchHash: string;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  githubReference: string | null;
  status: PatchFixStatus;
  attempt: number;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TransientPatchCandidate {
  schemaVersion: 1;
  proposalId: string;
  reviewRunId: string;
  findingId: string;
  baseSha: string;
  headSha: string;
  deliveryMode: 'suggestion';
  patchHash: string;
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
  approvalRequired: true;
  originalHash: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha1Pattern = /^[a-f0-9]{40}$/i;
const sha256Pattern = /^[a-f0-9]{64}$/i;
const statuses = new Set<PatchFixStatus>([
  'awaiting_approval', 'queued', 'reproving', 'resolved', 'unresolved',
  'inconclusive', 'rejected', 'failed',
]);

function parseFix(input: unknown): DashboardPatchFix {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Patch fix response was invalid.');
  }
  const value = input as Record<string, unknown>;
  if (
    typeof value.proposalId !== 'string' || !uuidPattern.test(value.proposalId) ||
    typeof value.findingId !== 'string' || !uuidPattern.test(value.findingId) ||
    typeof value.headSha !== 'string' || !sha1Pattern.test(value.headSha) ||
    typeof value.patchHash !== 'string' || !sha256Pattern.test(value.patchHash) ||
    (value.approvalStatus !== 'pending' && value.approvalStatus !== 'approved' &&
      value.approvalStatus !== 'rejected') ||
    (value.githubReference !== null && typeof value.githubReference !== 'string') ||
    typeof value.status !== 'string' || !statuses.has(value.status as PatchFixStatus) ||
    typeof value.attempt !== 'number' || !Number.isInteger(value.attempt) ||
    value.attempt < 0 ||
    (value.failureCode !== null && typeof value.failureCode !== 'string') ||
    typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' ||
    (value.completedAt !== null && typeof value.completedAt !== 'string')
  ) {
    throw new Error('Patch fix response was invalid.');
  }
  return value as unknown as DashboardPatchFix;
}

export function parseDashboardPatchFixes(input: unknown): DashboardPatchFix[] {
  if (typeof input !== 'object' || input === null || !('fixes' in input)) {
    throw new Error('Patch fix response was invalid.');
  }
  const fixes = (input as { fixes: unknown }).fixes;
  if (!Array.isArray(fixes) || fixes.length > 100) {
    throw new Error('Patch fix response was invalid.');
  }
  return fixes.map(parseFix);
}

export function parsePatchProposalResponse(input: unknown): {
  candidate: TransientPatchCandidate;
  fix: DashboardPatchFix;
} {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Patch proposal response was invalid.');
  }
  const value = input as Record<string, unknown>;
  const candidate = value.candidate as Record<string, unknown> | undefined;
  const proposal = value.proposal as Record<string, unknown> | undefined;
  const job = value.job as Record<string, unknown> | undefined;
  if (
    candidate === undefined || proposal === undefined || job === undefined ||
    typeof proposal.id !== 'string' || !uuidPattern.test(proposal.id) ||
    proposal.approvalStatus !== 'pending' ||
    candidate.schemaVersion !== 1 ||
    typeof candidate.reviewRunId !== 'string' || !uuidPattern.test(candidate.reviewRunId) ||
    typeof candidate.findingId !== 'string' || !uuidPattern.test(candidate.findingId) ||
    typeof candidate.baseSha !== 'string' || !sha1Pattern.test(candidate.baseSha) ||
    typeof candidate.headSha !== 'string' || !sha1Pattern.test(candidate.headSha) ||
    candidate.deliveryMode !== 'suggestion' ||
    typeof candidate.patchHash !== 'string' || !sha256Pattern.test(candidate.patchHash) ||
    typeof candidate.originalHash !== 'string' || !sha256Pattern.test(candidate.originalHash) ||
    typeof candidate.path !== 'string' || candidate.path.length === 0 ||
    typeof candidate.startLine !== 'number' || !Number.isInteger(candidate.startLine) ||
    typeof candidate.endLine !== 'number' || !Number.isInteger(candidate.endLine) ||
    typeof candidate.replacement !== 'string' ||
    candidate.approvalRequired !== true ||
    candidate.startLine < 1 || candidate.endLine < candidate.startLine ||
    job.status !== 'awaiting_approval'
  ) {
    throw new Error('Patch proposal response was invalid.');
  }
  const fix = parseFix({
    proposalId: proposal.id,
    findingId: candidate.findingId,
    headSha: candidate.headSha,
    patchHash: candidate.patchHash,
    approvalStatus: proposal.approvalStatus,
    githubReference: proposal.githubReference ?? null,
    status: job.status,
    attempt: job.attempt,
    failureCode: job.failureCode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  });
  return {
    candidate: {
      schemaVersion: 1,
      proposalId: proposal.id,
      reviewRunId: candidate.reviewRunId,
      findingId: candidate.findingId,
      baseSha: candidate.baseSha,
      headSha: candidate.headSha,
      deliveryMode: 'suggestion',
      patchHash: candidate.patchHash,
      path: candidate.path,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      replacement: candidate.replacement,
      approvalRequired: true,
      originalHash: candidate.originalHash,
    },
    fix,
  };
}
