import { createHash } from 'node:crypto';

import {
  parsePatchFixJob,
  parsePatchProposal,
  parseWalkzConfig,
  type Evidence,
  type Finding,
  type PatchFixJob,
  type PatchProposal,
  type RepositoryConfig,
} from '@walkz/contracts';
import type { Pool } from 'pg';
import { z } from 'zod';

const sha1Schema = z.string().regex(/^[a-f0-9]{40}$/i)
  .transform((value) => value.toLowerCase());
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());
const proofOutcomeSchema = z.enum([
  'passed',
  'failed',
  'timed_out',
  'cancelled',
  'infrastructure_error',
]);
const sourceIdentitySchema = z.object({
  repositoryId: z.uuid(),
  actorUserId: z.uuid(),
  reviewRunId: z.uuid(),
  findingId: z.uuid(),
}).strict();
const claimedIdentitySchema = z.object({
  proposalId: z.uuid(),
  workerId: z.string().trim().min(1).max(128),
}).strict();

const sourceRowSchema = z.object({
  repositoryId: z.uuid(),
  installationId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  owner: z.string().trim().min(1).max(100),
  repository: z.string().trim().min(1).max(100),
  pullRequestNumber: z.number().int().positive(),
  reviewRunId: z.uuid(),
  findingId: z.uuid(),
  baseSha: sha1Schema,
  headSha: sha1Schema,
  configHash: sha256Schema,
  config: z.unknown(),
  provider: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(512),
  fingerprint: sha256Schema,
  category: z.enum([
    'correctness',
    'security',
    'performance',
    'reliability',
    'maintainability',
  ]),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  path: z.string().trim().min(1).max(4_096),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  claim: z.string().trim().min(1).max(2_000),
  failureMechanism: z.string().trim().min(1).max(4_000),
  suggestedProof: z.string().trim().min(1).max(4_000),
  advisoryConfidence: z.number().min(0).max(1),
  planDigest: sha256Schema,
  commandDigest: sha256Schema,
  baseOutcome: proofOutcomeSchema,
  headOutcome: proofOutcomeSchema,
  baseExitCode: z.number().int().nullable(),
  headExitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  sanitizedSummary: z.string().max(65_536),
  artifactHashes: z.array(sha256Schema).max(64),
  evidenceRecordedAt: z.coerce.date(),
}).strict().refine((row) => row.endLine >= row.startLine, {
  message: 'Finding end line must not precede its start line.',
  path: ['endLine'],
});

const claimedRowSchema = sourceRowSchema.extend({
  proposalId: z.uuid(),
  patchHash: sha256Schema,
  deliveryMode: z.literal('suggestion'),
  approvalStatus: z.literal('approved'),
  githubReferenceKind: z.enum(['review_comment', 'fix_branch']).nullable(),
  githubReferenceValue: z.string().nullable(),
  decidedByUserId: z.uuid(),
  decidedAt: z.coerce.date(),
  staleAt: z.coerce.date().nullable(),
  proposalCreatedAt: z.coerce.date(),
  proposalUpdatedAt: z.coerce.date(),
  promptVersion: z.string().trim().min(1).max(256),
  jobProvider: z.string().trim().min(1).max(128),
  jobModel: z.string().trim().min(1).max(512),
  proofPlanDigest: sha256Schema,
  proofCommandDigest: sha256Schema,
  jobStatus: z.literal('reproving'),
  attempt: z.number().int().positive(),
  failureCode: z.null(),
  jobCreatedAt: z.coerce.date(),
  jobUpdatedAt: z.coerce.date(),
  jobCompletedAt: z.null(),
}).strict();

type SourceRow = z.infer<typeof sourceRowSchema>;

export interface PatchFixProofBinding {
  planDigest: string;
  commandDigest: string;
  baseOutcome: 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'infrastructure_error';
  headOutcome: 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'infrastructure_error';
  baseExitCode: number | null;
  headExitCode: number | null;
  durationMs: number;
  sanitizedSummary: string;
  artifactHashes: string[];
  recordedAt: Date;
}

export interface VerifiedPatchFixSource {
  repositoryId: string;
  installationId: string;
  owner: string;
  repository: string;
  pullRequestNumber: number;
  reviewRunId: string;
  findingId: string;
  baseSha: string;
  headSha: string;
  configHash: string;
  config: RepositoryConfig;
  provider: string;
  model: string;
  finding: Finding;
  proof: PatchFixProofBinding;
}

export interface ClaimedPatchFixTarget extends VerifiedPatchFixSource {
  proposal: PatchProposal;
  job: PatchFixJob;
  decidedByUserId: string;
}

const sourceColumns = `
  r.id AS "repositoryId",
  gi.github_id::text AS "installationId",
  r.owner_login AS owner,
  r.repository_name AS repository,
  pr.number AS "pullRequestNumber",
  rr.id AS "reviewRunId",
  f.id AS "findingId",
  rr.base_sha AS "baseSha",
  rr.head_sha AS "headSha",
  rr.config_hash AS "configHash",
  rc.config,
  rr.provider,
  rr.model,
  f.fingerprint,
  f.category,
  f.severity,
  f.file_path AS path,
  f.start_line AS "startLine",
  f.end_line AS "endLine",
  f.claim,
  f.failure_mechanism AS "failureMechanism",
  f.suggested_proof AS "suggestedProof",
  f.advisory_confidence AS "advisoryConfidence",
  e.plan_digest AS "planDigest",
  e.command_digest AS "commandDigest",
  e.base_outcome AS "baseOutcome",
  e.head_outcome AS "headOutcome",
  e.base_exit_code AS "baseExitCode",
  e.head_exit_code AS "headExitCode",
  e.duration_ms AS "durationMs",
  e.sanitized_summary AS "sanitizedSummary",
  e.artifact_hashes AS "artifactHashes",
  e.created_at AS "evidenceRecordedAt"
`;

function sourceFromRow(row: SourceRow): VerifiedPatchFixSource {
  const config = parseWalkzConfig(row.config);
  const computedHash = createHash('sha256')
    .update(JSON.stringify(config), 'utf8')
    .digest('hex');
  if (computedHash !== row.configHash) {
    throw new Error('Patch fix configuration does not match its immutable hash.');
  }
  if (row.provider !== config.provider.name) {
    throw new Error('Patch fix provider does not match its immutable configuration.');
  }
  const proof: PatchFixProofBinding = {
    planDigest: row.planDigest,
    commandDigest: row.commandDigest,
    baseOutcome: row.baseOutcome,
    headOutcome: row.headOutcome,
    baseExitCode: row.baseExitCode,
    headExitCode: row.headExitCode,
    durationMs: row.durationMs,
    sanitizedSummary: row.sanitizedSummary,
    artifactHashes: row.artifactHashes,
    recordedAt: row.evidenceRecordedAt,
  };
  const evidence: Evidence = {
    kind: 'counterfactual_proof',
    planDigest: proof.planDigest,
    commandDigest: proof.commandDigest,
    baseSha: row.baseSha,
    headSha: row.headSha,
    baseOutcome: proof.baseOutcome,
    headOutcome: proof.headOutcome,
    baseExitCode: proof.baseExitCode,
    headExitCode: proof.headExitCode,
    durationMs: proof.durationMs,
    sanitizedSummary: proof.sanitizedSummary,
    artifactHashes: proof.artifactHashes,
    recordedAt: proof.recordedAt.toISOString(),
  };
  const finding: Finding = {
    fingerprint: row.fingerprint,
    category: row.category,
    severity: row.severity,
    file: row.path,
    line: row.startLine,
    endLine: row.endLine,
    claim: row.claim,
    failureMechanism: row.failureMechanism,
    suggestedProof: row.suggestedProof,
    lifecycleStatus: 'verified',
    evidenceLevel: 'VERIFIED',
    advisoryConfidence: row.advisoryConfidence,
    evidence: [evidence],
    dismissal: null,
    fix: null,
  };
  return {
    repositoryId: row.repositoryId,
    installationId: row.installationId,
    owner: row.owner,
    repository: row.repository,
    pullRequestNumber: row.pullRequestNumber,
    reviewRunId: row.reviewRunId,
    findingId: row.findingId,
    baseSha: row.baseSha,
    headSha: row.headSha,
    configHash: row.configHash,
    config,
    provider: row.provider,
    model: row.model,
    finding,
    proof,
  };
}

const eligibleProofJoin = `
  JOIN LATERAL (
    SELECT evidence.plan_digest,
           evidence.command_digest,
           evidence.base_outcome,
           evidence.head_outcome,
           evidence.base_exit_code,
           evidence.head_exit_code,
           evidence.duration_ms,
           evidence.sanitized_summary,
           evidence.artifact_hashes,
           evidence.created_at
    FROM evidence
    WHERE evidence.finding_id = f.id
      AND evidence.evidence_kind = 'counterfactual_proof'
      AND evidence.plan_digest IS NOT NULL
      AND evidence.command_digest IS NOT NULL
      AND evidence.base_outcome = 'passed'
      AND evidence.head_outcome = 'failed'
      AND evidence.base_exit_code = 0
      AND evidence.head_exit_code <> 0
    ORDER BY evidence.created_at DESC, evidence.id DESC
    LIMIT 1
  ) e ON true
`;

export async function loadVerifiedPatchFixSource(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<VerifiedPatchFixSource | null> {
  const input = sourceIdentitySchema.parse(inputValue);
  const result = await pool.query(
    `SELECT ${sourceColumns}
     FROM review_runs rr
     JOIN repositories r ON r.id = rr.repository_id
     JOIN github_installations gi ON gi.id = r.installation_id
     JOIN user_installations ui
       ON ui.installation_id = gi.id AND ui.user_id = $2
     JOIN user_repository_access ura
       ON ura.user_id = ui.user_id
      AND ura.installation_id = gi.id
      AND ura.github_repository_id = r.github_id
     JOIN pull_requests pr ON pr.id = rr.pull_request_id
     JOIN repository_configs rc ON rc.id = rr.config_id
     JOIN findings f ON f.review_run_id = rr.id AND f.id = $4
     ${eligibleProofJoin}
     WHERE r.id = $1
       AND rr.id = $3
       AND rr.status = 'awaiting_human'
       AND pr.head_sha = rr.head_sha
       AND f.lifecycle_status = 'verified'
       AND f.evidence_level = 'VERIFIED'
     LIMIT 1`,
    [input.repositoryId, input.actorUserId, input.reviewRunId, input.findingId],
  );
  return result.rows[0] === undefined
    ? null
    : sourceFromRow(sourceRowSchema.parse(result.rows[0]));
}

export async function loadClaimedPatchFixTarget(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<ClaimedPatchFixTarget | null> {
  const input = claimedIdentitySchema.parse(inputValue);
  const result = await pool.query(
    `SELECT ${sourceColumns},
            pp.id AS "proposalId",
            pp.patch_hash AS "patchHash",
            pp.delivery_mode AS "deliveryMode",
            pp.approval_status AS "approvalStatus",
            pp.github_reference_kind AS "githubReferenceKind",
            pp.github_reference AS "githubReferenceValue",
            pp.decided_by_user_id AS "decidedByUserId",
            pp.decided_at AS "decidedAt",
            pp.stale_at AS "staleAt",
            pp.created_at AS "proposalCreatedAt",
            pp.updated_at AS "proposalUpdatedAt",
            pfj.prompt_version AS "promptVersion",
            pfj.provider AS "jobProvider",
            pfj.model AS "jobModel",
            pfj.proof_plan_digest AS "proofPlanDigest",
            pfj.proof_command_digest AS "proofCommandDigest",
            pfj.status AS "jobStatus",
            pfj.attempt,
            pfj.failure_code AS "failureCode",
            pfj.created_at AS "jobCreatedAt",
            pfj.updated_at AS "jobUpdatedAt",
            pfj.completed_at AS "jobCompletedAt"
     FROM patch_fix_jobs pfj
     JOIN patch_proposals pp ON pp.id = pfj.proposal_id
     JOIN review_runs rr ON rr.id = pp.review_run_id
     JOIN repositories r ON r.id = rr.repository_id
     JOIN github_installations gi ON gi.id = r.installation_id
     JOIN pull_requests pr ON pr.id = rr.pull_request_id
     JOIN repository_configs rc ON rc.id = rr.config_id
     JOIN findings f
       ON f.review_run_id = rr.id AND f.id = pp.finding_id
     ${eligibleProofJoin}
     WHERE pfj.proposal_id = $1
       AND pfj.status = 'reproving'
       AND pfj.lease_owner = $2
       AND pfj.lease_expires_at > now()
       AND pp.stale_at IS NULL
       AND pp.head_sha = pr.head_sha
       AND rr.status = 'awaiting_human'
       AND f.lifecycle_status = 'verified'
       AND f.evidence_level = 'VERIFIED'
       AND e.plan_digest = pfj.proof_plan_digest
       AND e.command_digest = pfj.proof_command_digest
     LIMIT 1`,
    [input.proposalId, input.workerId],
  );
  const value = result.rows[0];
  if (value === undefined) return null;
  const row = claimedRowSchema.parse(value);
  const source = sourceFromRow(row);
  const proposal = parsePatchProposal({
    id: row.proposalId,
    reviewRunId: row.reviewRunId,
    findingId: row.findingId,
    baseSha: row.baseSha,
    headSha: row.headSha,
    patchHash: row.patchHash,
    deliveryMode: row.deliveryMode,
    approvalStatus: row.approvalStatus,
    githubReference: row.githubReferenceKind === null ? null : {
      kind: row.githubReferenceKind,
      value: row.githubReferenceValue,
    },
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    staleAt: row.staleAt,
    createdAt: row.proposalCreatedAt,
    updatedAt: row.proposalUpdatedAt,
  });
  const job = parsePatchFixJob({
    proposalId: row.proposalId,
    provider: row.jobProvider,
    model: row.jobModel,
    promptVersion: row.promptVersion,
    proofPlanDigest: row.proofPlanDigest,
    proofCommandDigest: row.proofCommandDigest,
    status: row.jobStatus,
    attempt: row.attempt,
    failureCode: row.failureCode,
    createdAt: row.jobCreatedAt,
    updatedAt: row.jobUpdatedAt,
    completedAt: row.jobCompletedAt,
  });
  return { ...source, proposal, job, decidedByUserId: row.decidedByUserId };
}
