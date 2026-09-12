import {
  parsePatchFixJob,
  type PatchFixJob,
  type PatchProposal,
} from '@walkz/contracts';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import {
  createPatchProposalInTransaction,
  decidePatchProposalInTransaction,
  type PatchProposalDecisionOutcome,
} from './patch-proposal.js';
import {
  createPatchFixQueuedOutboxEvent,
  withTransaction,
} from './outbox.js';

const sha1Schema = z.string().regex(/^[a-f0-9]{40}$/i)
  .transform((value) => value.toLowerCase());
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());

const patchFixProposalInputSchema = z.object({
  proposal: z.object({
    reviewRunId: z.uuid(),
    findingId: z.uuid(),
    baseSha: sha1Schema,
    headSha: sha1Schema,
    patchHash: sha256Schema,
    deliveryMode: z.literal('suggestion'),
  }).strict(),
  provider: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(512),
  promptVersion: z.string().trim().min(1).max(256),
  proofPlanDigest: sha256Schema,
  proofCommandDigest: sha256Schema,
}).strict();

const patchFixDecisionInputSchema = z.object({
  repositoryId: z.uuid(),
  actorUserId: z.uuid(),
  proposalId: z.uuid(),
  expectedPatchHash: sha256Schema,
  expectedHeadSha: sha1Schema,
  decision: z.enum(['approved', 'rejected']),
}).strict();

const patchFixLeaseSchema = z.object({
  proposalId: z.uuid(),
  workerId: z.string().trim().min(1).max(128),
  leaseMs: z.number().int().min(10_000).max(60 * 60 * 1_000),
}).strict();

const patchFixCompletionSchema = patchFixLeaseSchema.omit({ leaseMs: true }).extend({
  outcome: z.enum(['resolved', 'unresolved', 'inconclusive']),
}).strict();

const patchFixFailureSchema = patchFixLeaseSchema.omit({ leaseMs: true }).extend({
  failureCode: z.enum([
    'candidate_changed',
    'proof_binding_invalid',
    'proof_infrastructure_failed',
    'github_publication_failed',
    'workflow_failed',
  ]),
}).strict();

const patchFixJobRowSchema = z.object({
  proposalId: z.uuid(),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  proofPlanDigest: sha256Schema,
  proofCommandDigest: sha256Schema,
  status: z.string(),
  attempt: z.number().int(),
  failureCode: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  completedAt: z.coerce.date().nullable(),
}).strict();

const patchFixListInputSchema = z.object({
  repositoryId: z.uuid(),
  reviewRunId: z.uuid(),
}).strict();
const patchFixListRowSchema = z.object({
  proposalId: z.uuid(),
  findingId: z.uuid(),
  headSha: sha1Schema,
  patchHash: sha256Schema,
  approvalStatus: z.enum(['pending', 'approved', 'rejected']),
  githubReference: z.string().nullable(),
  status: z.enum([
    'awaiting_approval',
    'queued',
    'reproving',
    'resolved',
    'unresolved',
    'inconclusive',
    'rejected',
    'failed',
  ]),
  attempt: z.number().int().nonnegative(),
  failureCode: z.enum([
    'candidate_changed',
    'proof_binding_invalid',
    'proof_infrastructure_failed',
    'github_publication_failed',
    'workflow_failed',
  ]).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  completedAt: z.coerce.date().nullable(),
}).strict();

export type PatchFixListItem = z.infer<typeof patchFixListRowSchema>;

function jobColumns(prefix = ''): string {
  return `
    ${prefix}proposal_id AS "proposalId",
    ${prefix}provider,
    ${prefix}model,
    ${prefix}prompt_version AS "promptVersion",
    ${prefix}proof_plan_digest AS "proofPlanDigest",
    ${prefix}proof_command_digest AS "proofCommandDigest",
    ${prefix}status,
    ${prefix}attempt,
    ${prefix}failure_code AS "failureCode",
    ${prefix}created_at AS "createdAt",
    ${prefix}updated_at AS "updatedAt",
    ${prefix}completed_at AS "completedAt"
  `;
}

export interface CreatedPatchFixProposal {
  proposal: PatchProposal;
  job: PatchFixJob;
  created: boolean;
}

export interface DecidedPatchFixProposal {
  outcome: PatchProposalDecisionOutcome;
  proposal: PatchProposal | null;
  job: PatchFixJob | null;
  outboxEventId: string | null;
}

function parseJob(input: unknown): PatchFixJob {
  return parsePatchFixJob(patchFixJobRowSchema.parse(input));
}

async function loadJob(
  client: Pick<PoolClient, 'query'>,
  proposalId: string,
  lock = false,
): Promise<PatchFixJob | null> {
  const result = await client.query(
    `SELECT ${jobColumns('pfj.')}
     FROM patch_fix_jobs pfj
     WHERE pfj.proposal_id = $1${lock ? ' FOR UPDATE OF pfj' : ''}`,
    [proposalId],
  );
  return result.rows[0] === undefined ? null : parseJob(result.rows[0]);
}

function sameGenerationBinding(
  job: PatchFixJob,
  input: z.infer<typeof patchFixProposalInputSchema>,
): boolean {
  return job.provider === input.provider &&
    job.model === input.model &&
    job.promptVersion === input.promptVersion &&
    job.proofPlanDigest === input.proofPlanDigest &&
    job.proofCommandDigest === input.proofCommandDigest;
}

export async function createPatchFixProposal(
  pool: Pick<Pool, 'connect'>,
  inputValue: unknown,
): Promise<CreatedPatchFixProposal> {
  const input = patchFixProposalInputSchema.parse(inputValue);
  return withTransaction(pool, async (client) => {
    const proposal = await createPatchProposalInTransaction(client, input.proposal);
    const inserted = await client.query(
      `INSERT INTO patch_fix_jobs (
         proposal_id, provider, model, prompt_version,
         proof_plan_digest, proof_command_digest
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (proposal_id) DO NOTHING
       RETURNING ${jobColumns()}`,
      [
        proposal.proposal.id,
        input.provider,
        input.model,
        input.promptVersion,
        input.proofPlanDigest,
        input.proofCommandDigest,
      ],
    );
    const insertedRow = inserted.rows[0];
    const job = insertedRow === undefined
      ? await loadJob(client, proposal.proposal.id, true)
      : parseJob(insertedRow);
    if (job === null || !sameGenerationBinding(job, input)) {
      throw new Error('Patch fix proposal generation metadata conflicts with its hash.');
    }
    return {
      proposal: proposal.proposal,
      job,
      created: insertedRow !== undefined,
    };
  });
}

export async function decidePatchFixProposal(
  pool: Pick<Pool, 'connect'>,
  inputValue: unknown,
): Promise<DecidedPatchFixProposal> {
  const input = patchFixDecisionInputSchema.parse(inputValue);
  return withTransaction(pool, async (client) => {
    const decision = await decidePatchProposalInTransaction(client, input);
    if (decision.proposal === null) {
      return { ...decision, job: null, outboxEventId: null };
    }
    if (
      decision.outcome === 'conflict' ||
      decision.outcome === 'denied' ||
      decision.outcome === 'stale'
    ) {
      return {
        ...decision,
        job: await loadJob(client, decision.proposal.id, true),
        outboxEventId: null,
      };
    }

    const job = await loadJob(client, decision.proposal.id, true);
    if (job === null) {
      throw new Error('Patch proposal does not have a durable fix job.');
    }
    if (input.decision === 'rejected') {
      const updated = job.status === 'awaiting_approval'
        ? await client.query(
            `UPDATE patch_fix_jobs
             SET status = 'rejected', updated_at = now(), completed_at = now()
             WHERE proposal_id = $1 AND status = 'awaiting_approval'
             RETURNING ${jobColumns()}`,
            [job.proposalId],
          )
        : { rows: [] };
      return {
        ...decision,
        job: updated.rows[0] === undefined ? job : parseJob(updated.rows[0]),
        outboxEventId: null,
      };
    }

    if (job.status === 'rejected') {
      throw new Error('Approved proposal has a rejected fix job.');
    }
    if (job.status === 'failed') {
      return { ...decision, outcome: 'conflict', job, outboxEventId: null };
    }
    let queued = job;
    if (job.status === 'awaiting_approval') {
      const updated = await client.query(
        `UPDATE patch_fix_jobs
         SET status = 'queued', updated_at = now()
         WHERE proposal_id = $1 AND status = 'awaiting_approval'
         RETURNING ${jobColumns()}`,
        [job.proposalId],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error('Patch fix job changed while it was queued.');
      }
      queued = parseJob(row);
    }
    const outboxEventId = await createPatchFixQueuedOutboxEvent(client, {
      aggregateId: job.proposalId,
      eventType: 'patch_fix.queued',
      payload: { proposalId: job.proposalId },
    });
    return { ...decision, job: queued, outboxEventId };
  });
}

export async function getPatchFixJob(
  pool: Pick<Pool, 'query'>,
  proposalId: unknown,
): Promise<PatchFixJob | null> {
  const id = z.uuid().parse(proposalId);
  return loadJob(pool, id);
}

export async function claimPatchFixJob(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<PatchFixJob | null> {
  const input = patchFixLeaseSchema.parse(inputValue);
  const result = await pool.query(
    `UPDATE patch_fix_jobs pfj
     SET status = 'reproving',
         attempt = attempt + 1,
         lease_owner = $2,
         lease_expires_at = now() + ($3 * interval '1 millisecond'),
         updated_at = now()
     FROM patch_proposals pp,
          review_runs rr,
          pull_requests pr,
          findings f
     WHERE pfj.proposal_id = $1
       AND pp.id = pfj.proposal_id
       AND rr.id = pp.review_run_id
       AND pr.id = rr.pull_request_id
       AND f.id = pp.finding_id
       AND f.review_run_id = pp.review_run_id
       AND pp.approval_status = 'approved'
       AND pp.decided_by_user_id IS NOT NULL
       AND pp.stale_at IS NULL
       AND pp.head_sha = pr.head_sha
       AND rr.status = 'awaiting_human'
       AND f.lifecycle_status = 'verified'
       AND f.evidence_level = 'VERIFIED'
       AND pfj.attempt < 5
       AND (
         pfj.status = 'queued' OR (
           pfj.status = 'reproving' AND
           (pfj.lease_expires_at IS NULL OR pfj.lease_expires_at <= now())
         )
       )
     RETURNING ${jobColumns('pfj.')}`,
    [input.proposalId, input.workerId, input.leaseMs],
  );
  return result.rows[0] === undefined ? null : parseJob(result.rows[0]);
}

export async function renewPatchFixJobLease(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<boolean> {
  const input = patchFixLeaseSchema.parse(inputValue);
  const result = await pool.query(
    `UPDATE patch_fix_jobs
     SET lease_expires_at = now() + ($3 * interval '1 millisecond')
     WHERE proposal_id = $1
       AND lease_owner = $2
       AND status = 'reproving'
     RETURNING proposal_id`,
    [input.proposalId, input.workerId, input.leaseMs],
  );
  return result.rows.length === 1;
}

export async function releasePatchFixJob(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<boolean> {
  const input = patchFixLeaseSchema.omit({ leaseMs: true }).parse(inputValue);
  const result = await pool.query(
    `UPDATE patch_fix_jobs
     SET status = 'queued',
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE proposal_id = $1
       AND lease_owner = $2
       AND status = 'reproving'
       AND attempt < 5
     RETURNING proposal_id`,
    [input.proposalId, input.workerId],
  );
  return result.rows.length === 1;
}

export async function completePatchFixJob(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<PatchFixJob | null> {
  const input = patchFixCompletionSchema.parse(inputValue);
  const result = await pool.query(
    `UPDATE patch_fix_jobs pfj
     SET status = $3,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now(),
         completed_at = now()
     FROM patch_proposals pp
     WHERE pfj.proposal_id = $1
       AND pfj.lease_owner = $2
       AND pfj.status = 'reproving'
       AND pp.id = pfj.proposal_id
       AND EXISTS (
         SELECT 1
         FROM evidence e
         WHERE e.evidence_kind = 'patch_reproof'
           AND e.patch_proposal_id = pfj.proposal_id
           AND e.reproof_outcome = $3
       )
       AND ($3 <> 'resolved' OR pp.github_reference IS NOT NULL)
     RETURNING ${jobColumns('pfj.')}`,
    [input.proposalId, input.workerId, input.outcome],
  );
  return result.rows[0] === undefined ? null : parseJob(result.rows[0]);
}

export async function failPatchFixJob(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<PatchFixJob | null> {
  const input = patchFixFailureSchema.parse(inputValue);
  const result = await pool.query(
    `UPDATE patch_fix_jobs
     SET status = 'failed',
         failure_code = $3,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = now(),
         completed_at = now()
     WHERE proposal_id = $1
       AND lease_owner = $2
       AND status = 'reproving'
     RETURNING ${jobColumns()}`,
    [input.proposalId, input.workerId, input.failureCode],
  );
  return result.rows[0] === undefined ? null : parseJob(result.rows[0]);
}

export async function listRecoverablePatchFixProposalIds(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<string[]> {
  const limit = z.number().int().min(1).max(1_000).parse(inputValue);
  const result = await pool.query<{ proposalId: string }>(
    `SELECT proposal_id AS "proposalId"
     FROM patch_fix_jobs
     WHERE attempt < 5
       AND (
         status = 'queued' OR (
           status = 'reproving' AND
           (lease_expires_at IS NULL OR lease_expires_at <= now())
         )
       )
     ORDER BY updated_at ASC, proposal_id ASC
     LIMIT $1`,
    [limit],
  );
  return z.array(z.object({ proposalId: z.uuid() }).strict())
    .parse(result.rows)
    .map((row) => row.proposalId);
}

export async function listPatchFixes(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<PatchFixListItem[]> {
  const input = patchFixListInputSchema.parse(inputValue);
  const result = await pool.query(
    `SELECT pp.id AS "proposalId",
            pp.finding_id AS "findingId",
            pp.head_sha AS "headSha",
            pp.patch_hash AS "patchHash",
            pp.approval_status AS "approvalStatus",
            pp.github_reference AS "githubReference",
            pfj.status,
            pfj.attempt,
            pfj.failure_code AS "failureCode",
            pfj.created_at AS "createdAt",
            pfj.updated_at AS "updatedAt",
            pfj.completed_at AS "completedAt"
     FROM patch_fix_jobs pfj
     JOIN patch_proposals pp ON pp.id = pfj.proposal_id
     JOIN review_runs rr ON rr.id = pp.review_run_id
     WHERE rr.repository_id = $1
       AND rr.id = $2
     ORDER BY pfj.created_at DESC, pp.id DESC
     LIMIT 100`,
    [input.repositoryId, input.reviewRunId],
  );
  return result.rows.map((row) => patchFixListRowSchema.parse(row));
}
