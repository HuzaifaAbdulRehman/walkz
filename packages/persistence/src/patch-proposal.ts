import {
  canTransitionPatchApproval,
  evidenceLevelSchema,
  parsePatchProposal,
  patchApprovalStatusSchema,
  patchDeliveryModeSchema,
  reviewRunStatusSchema,
} from '@walkz/contracts';
import type {
  PatchApprovalStatus,
  PatchProposal,
} from '@walkz/contracts';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { recordAuditEvent } from './audit.js';
import { withTransaction } from './outbox.js';

const sha1Schema = z.string().regex(/^[a-f0-9]{40}$/i);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);

const createPatchProposalSchema = z
  .object({
    reviewRunId: z.uuid(),
    findingId: z.uuid(),
    baseSha: sha1Schema,
    headSha: sha1Schema,
    patchHash: sha256Schema,
    deliveryMode: patchDeliveryModeSchema,
  })
  .strict()
  .refine((proposal) => proposal.baseSha !== proposal.headSha, {
    message: 'Patch proposals must target a changed head revision.',
    path: ['headSha'],
  });

const patchProposalDecisionSchema = z
  .object({
    repositoryId: z.uuid(),
    actorUserId: z.uuid(),
    proposalId: z.uuid(),
    expectedPatchHash: sha256Schema,
    expectedHeadSha: sha1Schema,
    decision: z.enum(['approved', 'rejected']),
  })
  .strict();

const patchSuggestionPublicationSchema = z.object({
  repositoryId: z.uuid(),
  actorUserId: z.uuid(),
  proposalId: z.uuid(),
  expectedPatchHash: sha256Schema,
  expectedHeadSha: sha1Schema,
  publicationLeaseOwner: z.uuid(),
  publicationLeaseMs: z.number().int().min(10_000).max(5 * 60_000),
}).strict();

const recordPatchSuggestionPublicationSchema = patchSuggestionPublicationSchema.omit({
  publicationLeaseMs: true,
}).extend({
  githubReferenceValue: z.url().max(512).refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  }, { message: 'Patch suggestion references must be GitHub HTTPS URLs.' }),
}).strict();

const releasePatchSuggestionPublicationSchema = z.object({
  proposalId: z.uuid(),
  publicationLeaseOwner: z.uuid(),
}).strict();

const patchProposalRowSchema = z
  .object({
    id: z.uuid(),
    reviewRunId: z.uuid(),
    findingId: z.uuid(),
    baseSha: sha1Schema,
    headSha: sha1Schema,
    patchHash: sha256Schema,
    deliveryMode: patchDeliveryModeSchema,
    approvalStatus: patchApprovalStatusSchema,
    githubReferenceKind: z.enum(['review_comment', 'fix_branch']).nullable(),
    githubReferenceValue: z.string().nullable(),
    decidedByUserId: z.uuid().nullable(),
    decidedAt: z.coerce.date().nullable(),
    staleAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .strict();

const lockedPatchProposalRowSchema = patchProposalRowSchema.extend({
  currentHeadSha: sha1Schema,
  runStatus: reviewRunStatusSchema,
  findingLifecycleStatus: z.enum([
    'proposed',
    'challenged',
    'proving',
    'verified',
    'supported',
    'unverified',
    'dismissed',
    'fixed',
  ]),
  evidenceLevel: evidenceLevelSchema,
});

const lockedPatchSuggestionRowSchema = lockedPatchProposalRowSchema.extend({
  installationId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  owner: z.string().trim().min(1).max(100),
  repository: z.string().trim().min(1).max(100),
  pullRequestNumber: z.number().int().positive(),
  publicationLeaseOwner: z.uuid().nullable(),
  publicationLeaseExpiresAt: z.coerce.date().nullable(),
});

export interface CreatedPatchProposal {
  proposal: PatchProposal;
  created: boolean;
}

export type PatchProposalDecisionOutcome =
  | 'applied'
  | 'unchanged'
  | 'stale'
  | 'conflict'
  | 'denied';

export interface PatchProposalDecisionResult {
  outcome: PatchProposalDecisionOutcome;
  proposal: PatchProposal | null;
}

export interface PatchSuggestionPublicationTarget {
  proposal: PatchProposal;
  installationId: string;
  owner: string;
  repository: string;
  pullRequestNumber: number;
}

export type PatchSuggestionPublicationOutcome =
  | 'ready'
  | 'published'
  | 'applied'
  | 'unchanged'
  | 'busy'
  | 'stale'
  | 'conflict'
  | 'denied';

export interface PatchSuggestionPublicationResult {
  outcome: PatchSuggestionPublicationOutcome;
  target: PatchSuggestionPublicationTarget | null;
}

const proposalColumns = `
  pp.id,
  pp.review_run_id AS "reviewRunId",
  pp.finding_id AS "findingId",
  pp.base_sha AS "baseSha",
  pp.head_sha AS "headSha",
  pp.patch_hash AS "patchHash",
  pp.delivery_mode AS "deliveryMode",
  pp.approval_status AS "approvalStatus",
  pp.github_reference_kind AS "githubReferenceKind",
  pp.github_reference AS "githubReferenceValue",
  pp.decided_by_user_id AS "decidedByUserId",
  pp.decided_at AS "decidedAt",
  pp.stale_at AS "staleAt",
  pp.created_at AS "createdAt",
  pp.updated_at AS "updatedAt"
`;

function toPatchProposal(
  row: z.infer<typeof patchProposalRowSchema>,
): PatchProposal {
  const githubReference = row.githubReferenceKind === null
    ? null
    : {
        kind: row.githubReferenceKind,
        value: row.githubReferenceValue,
      };
  return parsePatchProposal({
    id: row.id,
    reviewRunId: row.reviewRunId,
    findingId: row.findingId,
    baseSha: row.baseSha,
    headSha: row.headSha,
    patchHash: row.patchHash,
    deliveryMode: row.deliveryMode,
    approvalStatus: row.approvalStatus,
    githubReference,
    decidedByUserId: row.decidedByUserId,
    decidedAt: row.decidedAt,
    staleAt: row.staleAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function parsePatchProposalRow(input: unknown): PatchProposal {
  return toPatchProposal(patchProposalRowSchema.parse(input));
}

async function findExistingProposal(
  client: Pick<PoolClient, 'query'>,
  proposal: z.infer<typeof createPatchProposalSchema>,
): Promise<PatchProposal | null> {
  const result = await client.query(
    `
      SELECT ${proposalColumns}
      FROM patch_proposals pp
      WHERE pp.finding_id = $1
        AND pp.head_sha = $2
        AND pp.patch_hash = $3
        AND pp.delivery_mode = $4
        AND pp.review_run_id = $5
        AND pp.base_sha = $6
      LIMIT 1
    `,
    [
      proposal.findingId,
      proposal.headSha,
      proposal.patchHash,
      proposal.deliveryMode,
      proposal.reviewRunId,
      proposal.baseSha,
    ],
  );
  const row = result.rows[0];
  return row === undefined ? null : parsePatchProposalRow(row);
}

export async function createPatchProposal(
  pool: Pick<Pool, 'connect'>,
  input: unknown,
): Promise<CreatedPatchProposal> {
  const proposal = createPatchProposalSchema.parse(input);
  return withTransaction(pool, async (client) => {
    const inserted = await client.query(
      `
        WITH eligible AS (
          SELECT rr.id AS review_run_id, f.id AS finding_id
          FROM review_runs rr
          JOIN pull_requests pr ON pr.id = rr.pull_request_id
          JOIN findings f
            ON f.review_run_id = rr.id AND f.id = $2
          WHERE rr.id = $1
            AND rr.base_sha = $3
            AND rr.head_sha = $4
            AND pr.head_sha = $4
            AND rr.status = 'awaiting_human'
            AND f.lifecycle_status = 'verified'
            AND f.evidence_level = 'VERIFIED'
          FOR UPDATE OF rr, pr, f
        )
        INSERT INTO patch_proposals (
          review_run_id, finding_id, base_sha, head_sha, patch_hash,
          delivery_mode, approval_status, updated_at
        )
        SELECT review_run_id, finding_id, $3, $4, $5, $6, 'pending', now()
        FROM eligible
        ON CONFLICT (finding_id, head_sha, patch_hash, delivery_mode)
          DO NOTHING
        RETURNING ${proposalColumns.replaceAll('pp.', '')}
      `,
      [
        proposal.reviewRunId,
        proposal.findingId,
        proposal.baseSha,
        proposal.headSha,
        proposal.patchHash,
        proposal.deliveryMode,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      const existing = await findExistingProposal(client, proposal);
      if (existing !== null) return { proposal: existing, created: false };
      throw new Error(
        'Patch proposals require an awaiting-human run and a verified finding.',
      );
    }

    const created = parsePatchProposalRow(row);
    await recordAuditEvent(client, {
      actorUserId: null,
      eventType: 'patch_proposal.created',
      summary: 'Walkz created a patch proposal for a verified finding.',
      metadata: {
        operation: 'create_patch_proposal',
        outcome: 'completed',
        subjectId: created.id,
      },
    });
    return { proposal: created, created: true };
  });
}

async function recordDecisionAudit(
  client: Pick<PoolClient, 'query'>,
  input: {
    actorUserId: string;
    eventType: string;
    operation: string;
    outcome: 'accepted' | 'rejected';
    proposalId: string;
    summary: string;
  },
): Promise<void> {
  await recordAuditEvent(client, {
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    summary: input.summary,
    metadata: {
      operation: input.operation,
      outcome: input.outcome,
      subjectId: input.proposalId,
    },
  });
}

async function lockAuthorizedProposal(
  client: Pick<PoolClient, 'query'>,
  proposalId: string,
  actorUserId: string,
  repositoryId: string,
) {
  const result = await client.query(
    `
      SELECT ${proposalColumns},
             pr.head_sha AS "currentHeadSha",
             rr.status AS "runStatus",
             f.lifecycle_status AS "findingLifecycleStatus",
             f.evidence_level AS "evidenceLevel"
      FROM patch_proposals pp
      JOIN review_runs rr ON rr.id = pp.review_run_id
      JOIN pull_requests pr ON pr.id = rr.pull_request_id
      JOIN findings f
        ON f.id = pp.finding_id AND f.review_run_id = pp.review_run_id
      JOIN repositories r ON r.id = rr.repository_id
      JOIN user_repository_access ura
        ON ura.installation_id = r.installation_id
       AND ura.github_repository_id = r.github_id
       AND ura.user_id = $2
      WHERE pp.id = $1 AND rr.repository_id = $3
      FOR UPDATE OF pp, pr
    `,
    [proposalId, actorUserId, repositoryId],
  );
  const row = result.rows[0];
  return row === undefined ? null : lockedPatchProposalRowSchema.parse(row);
}

async function lockAuthorizedPatchSuggestion(
  client: Pick<PoolClient, 'query'>,
  proposalId: string,
  actorUserId: string,
  repositoryId: string,
) {
  const result = await client.query(
    `
      SELECT ${proposalColumns},
             pr.head_sha AS "currentHeadSha",
             rr.status AS "runStatus",
             f.lifecycle_status AS "findingLifecycleStatus",
             f.evidence_level AS "evidenceLevel",
             gi.github_id::text AS "installationId",
             r.owner_login AS owner,
             r.repository_name AS repository,
             pr.number AS "pullRequestNumber",
             pp.publication_lease_owner AS "publicationLeaseOwner",
             pp.publication_lease_expires_at AS "publicationLeaseExpiresAt"
      FROM patch_proposals pp
      JOIN review_runs rr ON rr.id = pp.review_run_id
      JOIN pull_requests pr ON pr.id = rr.pull_request_id
      JOIN findings f
        ON f.id = pp.finding_id AND f.review_run_id = pp.review_run_id
      JOIN repositories r ON r.id = rr.repository_id
      JOIN github_installations gi ON gi.id = r.installation_id
      JOIN user_repository_access ura
        ON ura.installation_id = r.installation_id
       AND ura.github_repository_id = r.github_id
       AND ura.user_id = $2
      WHERE pp.id = $1 AND rr.repository_id = $3
      FOR UPDATE OF pp, pr
    `,
    [proposalId, actorUserId, repositoryId],
  );
  const row = result.rows[0];
  return row === undefined ? null : lockedPatchSuggestionRowSchema.parse(row);
}

function publicationTarget(
  row: z.infer<typeof lockedPatchSuggestionRowSchema>,
  proposal: PatchProposal = toPatchProposal(row),
): PatchSuggestionPublicationTarget {
  return {
    proposal,
    installationId: row.installationId,
    owner: row.owner,
    repository: row.repository,
    pullRequestNumber: row.pullRequestNumber,
  };
}

async function recordPublicationAudit(
  client: Pick<PoolClient, 'query'>,
  input: {
    actorUserId: string;
    eventType: string;
    outcome: 'accepted' | 'rejected';
    proposalId: string;
    summary: string;
  },
): Promise<void> {
  await recordAuditEvent(client, {
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    summary: input.summary,
    metadata: {
      operation: 'publish_patch_suggestion',
      outcome: input.outcome,
      subjectId: input.proposalId,
    },
  });
}

function publicationConflict(
  row: z.infer<typeof lockedPatchSuggestionRowSchema>,
  input: {
    expectedPatchHash: string;
    expectedHeadSha: string;
  },
): boolean {
  return row.patchHash.toLowerCase() !== input.expectedPatchHash.toLowerCase() ||
    row.headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase() ||
    row.deliveryMode !== 'suggestion' ||
    row.approvalStatus !== 'approved' ||
    (row.runStatus !== 'awaiting_human' && row.runStatus !== 'superseded') ||
    row.findingLifecycleStatus !== 'verified' ||
    row.evidenceLevel !== 'VERIFIED';
}

function publicationIsStale(
  row: z.infer<typeof lockedPatchSuggestionRowSchema>,
): boolean {
  return row.staleAt !== null ||
    row.currentHeadSha.toLowerCase() !== row.headSha.toLowerCase() ||
    row.runStatus === 'superseded';
}

async function markPublicationStale(
  client: Pick<PoolClient, 'query'>,
  row: z.infer<typeof lockedPatchSuggestionRowSchema>,
): Promise<PatchProposal> {
  if (row.staleAt !== null) return toPatchProposal(row);
  const result = await client.query(
    `
      UPDATE patch_proposals pp
      SET stale_at = now(), updated_at = now()
      WHERE pp.id = $1 AND pp.stale_at IS NULL
      RETURNING ${proposalColumns.replaceAll('pp.', '')}
    `,
    [row.id],
  );
  const updated = result.rows[0];
  if (updated === undefined) {
    throw new Error('Patch proposal changed while it was marked stale.');
  }
  return parsePatchProposalRow(updated);
}

export async function preparePatchSuggestionPublication(
  pool: Pick<Pool, 'connect'>,
  inputValue: unknown,
): Promise<PatchSuggestionPublicationResult> {
  const input = patchSuggestionPublicationSchema.parse(inputValue);
  return withTransaction(pool, async (client) => {
    const locked = await lockAuthorizedPatchSuggestion(
      client,
      input.proposalId,
      input.actorUserId,
      input.repositoryId,
    );
    if (locked === null) {
      await recordPublicationAudit(client, {
        actorUserId: input.actorUserId,
        eventType: 'patch_proposal.publication_denied',
        outcome: 'rejected',
        proposalId: input.proposalId,
        summary: 'A patch suggestion publication was denied.',
      });
      return { outcome: 'denied', target: null };
    }
    if (publicationConflict(locked, input)) {
      await recordPublicationAudit(client, {
        actorUserId: input.actorUserId,
        eventType: 'patch_proposal.publication_conflict',
        outcome: 'rejected',
        proposalId: input.proposalId,
        summary: 'A patch suggestion failed its approval or evidence gate.',
      });
      return { outcome: 'conflict', target: publicationTarget(locked) };
    }
    if (publicationIsStale(locked)) {
      const stale = await markPublicationStale(client, locked);
      await recordPublicationAudit(client, {
        actorUserId: input.actorUserId,
        eventType: 'patch_proposal.publication_stale',
        outcome: 'rejected',
        proposalId: input.proposalId,
        summary: 'A stale patch suggestion publication was rejected.',
      });
      return { outcome: 'stale', target: publicationTarget(locked, stale) };
    }
    const target = publicationTarget(locked);
    if (target.proposal.githubReference !== null) {
      return { outcome: 'published', target };
    }
    const claimed = await client.query(
      `
        UPDATE patch_proposals
        SET publication_lease_owner = $2,
            publication_lease_expires_at = now() + ($3 * interval '1 millisecond')
        WHERE id = $1
          AND github_reference IS NULL
          AND (
            publication_lease_owner IS NULL OR
            publication_lease_expires_at <= now() OR
            publication_lease_owner = $2
          )
        RETURNING id
      `,
      [locked.id, input.publicationLeaseOwner, input.publicationLeaseMs],
    );
    if (claimed.rows.length !== 1) {
      return { outcome: 'busy', target };
    }
    return {
      outcome: 'ready',
      target,
    };
  });
}

export async function recordPatchSuggestionPublication(
  pool: Pick<Pool, 'connect'>,
  inputValue: unknown,
): Promise<PatchSuggestionPublicationResult> {
  const input = recordPatchSuggestionPublicationSchema.parse(inputValue);
  return withTransaction(pool, async (client) => {
    const locked = await lockAuthorizedPatchSuggestion(
      client,
      input.proposalId,
      input.actorUserId,
      input.repositoryId,
    );
    if (locked === null) {
      await recordPublicationAudit(client, {
        actorUserId: input.actorUserId,
        eventType: 'patch_proposal.publication_denied',
        outcome: 'rejected',
        proposalId: input.proposalId,
        summary: 'A patch suggestion publication result was denied.',
      });
      return { outcome: 'denied', target: null };
    }
    if (publicationConflict(locked, input)) {
      await recordPublicationAudit(client, {
        actorUserId: input.actorUserId,
        eventType: 'patch_proposal.publication_conflict',
        outcome: 'rejected',
        proposalId: input.proposalId,
        summary: 'A patch suggestion result failed its approval or evidence gate.',
      });
      return { outcome: 'conflict', target: publicationTarget(locked) };
    }
    if (locked.githubReferenceValue !== null) {
      const unchanged = locked.githubReferenceKind === 'review_comment' &&
        locked.githubReferenceValue === input.githubReferenceValue;
      await recordPublicationAudit(client, {
        actorUserId: input.actorUserId,
        eventType: unchanged
          ? 'patch_proposal.publication_unchanged'
          : 'patch_proposal.publication_conflict',
        outcome: unchanged ? 'accepted' : 'rejected',
        proposalId: input.proposalId,
        summary: unchanged
          ? 'The GitHub patch suggestion was already recorded.'
          : 'A different GitHub reference was already recorded.',
      });
      return {
        outcome: unchanged ? 'unchanged' : 'conflict',
        target: publicationTarget(locked),
      };
    }
    if (locked.publicationLeaseOwner !== input.publicationLeaseOwner) {
      await recordPublicationAudit(client, {
        actorUserId: input.actorUserId,
        eventType: 'patch_proposal.publication_conflict',
        outcome: 'rejected',
        proposalId: input.proposalId,
        summary: 'A patch suggestion result did not own the publication lease.',
      });
      return { outcome: 'conflict', target: publicationTarget(locked) };
    }

    const stale = publicationIsStale(locked);
    const result = await client.query(
      `
        UPDATE patch_proposals pp
        SET github_reference_kind = 'review_comment',
            github_reference = $2,
            stale_at = CASE WHEN $3 THEN COALESCE(stale_at, now()) ELSE stale_at END,
            publication_lease_owner = NULL,
            publication_lease_expires_at = NULL,
            updated_at = now()
        WHERE pp.id = $1
          AND pp.github_reference IS NULL
          AND pp.approval_status = 'approved'
          AND pp.patch_hash = $4
          AND pp.head_sha = $5
          AND pp.publication_lease_owner = $6
        RETURNING ${proposalColumns.replaceAll('pp.', '')}
      `,
      [
        locked.id,
        input.githubReferenceValue,
        stale,
        input.expectedPatchHash,
        input.expectedHeadSha,
        input.publicationLeaseOwner,
      ],
    );
    const updated = result.rows[0];
    if (updated === undefined) {
      throw new Error('Patch proposal changed while its GitHub reference was stored.');
    }
    const proposal = parsePatchProposalRow(updated);
    await recordPublicationAudit(client, {
      actorUserId: input.actorUserId,
      eventType: stale
        ? 'patch_proposal.suggestion_published_stale'
        : 'patch_proposal.suggestion_published',
      outcome: 'accepted',
      proposalId: input.proposalId,
      summary: stale
        ? 'A GitHub patch suggestion was recorded after its proposal became stale.'
        : 'A GitHub patch suggestion was recorded.',
    });
    return {
      outcome: stale ? 'stale' : 'applied',
      target: publicationTarget(locked, proposal),
    };
  });
}

export async function releasePatchSuggestionPublication(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<boolean> {
  const input = releasePatchSuggestionPublicationSchema.parse(inputValue);
  const result = await pool.query(
    `
      UPDATE patch_proposals
      SET publication_lease_owner = NULL,
          publication_lease_expires_at = NULL
      WHERE id = $1 AND publication_lease_owner = $2
      RETURNING id
    `,
    [input.proposalId, input.publicationLeaseOwner],
  );
  return result.rows.length === 1;
}

export async function decidePatchProposal(
  pool: Pick<Pool, 'connect'>,
  input: unknown,
): Promise<PatchProposalDecisionResult> {
  const decision = patchProposalDecisionSchema.parse(input);
  const operation = `${decision.decision === 'approved' ? 'approve' : 'reject'}_patch_proposal`;

  return withTransaction(pool, async (client) => {
    const locked = await lockAuthorizedProposal(
      client,
      decision.proposalId,
      decision.actorUserId,
      decision.repositoryId,
    );
    if (locked === null) {
      await recordDecisionAudit(client, {
        actorUserId: decision.actorUserId,
        eventType: 'patch_proposal.decision_denied',
        operation,
        outcome: 'rejected',
        proposalId: decision.proposalId,
        summary: 'A patch proposal decision was denied.',
      });
      return { outcome: 'denied', proposal: null };
    }

    const proposal = toPatchProposal(locked);
    if (
      proposal.patchHash !== decision.expectedPatchHash ||
      proposal.headSha !== decision.expectedHeadSha
    ) {
      await recordDecisionAudit(client, {
        actorUserId: decision.actorUserId,
        eventType: 'patch_proposal.decision_conflict',
        operation,
        outcome: 'rejected',
        proposalId: proposal.id,
        summary: 'A patch proposal decision did not match its hash or head.',
      });
      return { outcome: 'conflict', proposal };
    }

    if (
      proposal.staleAt !== null ||
      locked.currentHeadSha !== proposal.headSha ||
      locked.runStatus === 'superseded'
    ) {
      let staleProposal = proposal;
      if (proposal.staleAt === null) {
        const staleResult = await client.query(
          `
            UPDATE patch_proposals pp
            SET stale_at = now(), updated_at = now()
            WHERE pp.id = $1 AND pp.stale_at IS NULL
            RETURNING ${proposalColumns.replaceAll('pp.', '')}
          `,
          [proposal.id],
        );
        const staleRow = staleResult.rows[0];
        if (staleRow !== undefined) {
          staleProposal = parsePatchProposalRow(staleRow);
        }
      }
      await recordDecisionAudit(client, {
        actorUserId: decision.actorUserId,
        eventType: 'patch_proposal.stale',
        operation,
        outcome: 'rejected',
        proposalId: proposal.id,
        summary: 'A stale patch proposal decision was rejected.',
      });
      return { outcome: 'stale', proposal: staleProposal };
    }

    if (
      locked.runStatus !== 'awaiting_human' ||
      locked.findingLifecycleStatus !== 'verified' ||
      locked.evidenceLevel !== 'VERIFIED'
    ) {
      await recordDecisionAudit(client, {
        actorUserId: decision.actorUserId,
        eventType: 'patch_proposal.decision_conflict',
        operation,
        outcome: 'rejected',
        proposalId: proposal.id,
        summary: 'A patch proposal decision failed its evidence or run-state gate.',
      });
      return { outcome: 'conflict', proposal };
    }

    if (proposal.approvalStatus === decision.decision) {
      const outcome = proposal.decidedByUserId === decision.actorUserId
        ? 'unchanged'
        : 'conflict';
      await recordDecisionAudit(client, {
        actorUserId: decision.actorUserId,
        eventType: outcome === 'unchanged'
          ? 'patch_proposal.decision_unchanged'
          : 'patch_proposal.decision_conflict',
        operation,
        outcome: outcome === 'unchanged' ? 'accepted' : 'rejected',
        proposalId: proposal.id,
        summary: outcome === 'unchanged'
          ? 'A patch proposal decision was already stored.'
          : 'A different user already decided this patch proposal.',
      });
      return { outcome, proposal };
    }
    if (!canTransitionPatchApproval(proposal.approvalStatus, decision.decision)) {
      await recordDecisionAudit(client, {
        actorUserId: decision.actorUserId,
        eventType: 'patch_proposal.decision_conflict',
        operation,
        outcome: 'rejected',
        proposalId: proposal.id,
        summary: 'A final patch proposal decision cannot be changed.',
      });
      return { outcome: 'conflict', proposal };
    }

    const updated = await client.query(
      `
        UPDATE patch_proposals pp
        SET approval_status = $2,
            decided_by_user_id = $3,
            decided_at = now(),
            updated_at = now()
        WHERE pp.id = $1
          AND pp.approval_status = $4
          AND pp.stale_at IS NULL
          AND pp.patch_hash = $5
          AND pp.head_sha = $6
        RETURNING ${proposalColumns.replaceAll('pp.', '')}
      `,
      [
        proposal.id,
        decision.decision,
        decision.actorUserId,
        proposal.approvalStatus,
        decision.expectedPatchHash,
        decision.expectedHeadSha,
      ],
    );
    const updatedRow = updated.rows[0];
    if (updatedRow === undefined) {
      throw new Error('Patch proposal changed while its decision was stored.');
    }
    const decidedProposal = parsePatchProposalRow(updatedRow);
    await recordDecisionAudit(client, {
      actorUserId: decision.actorUserId,
      eventType: `patch_proposal.${decision.decision}`,
      operation,
      outcome: 'accepted',
      proposalId: proposal.id,
      summary: `A user ${decision.decision} a patch proposal.`,
    });
    return { outcome: 'applied', proposal: decidedProposal };
  });
}
