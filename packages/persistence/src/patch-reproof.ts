import { isDeepStrictEqual } from 'node:util';

import {
  parsePatchReproofResult,
  type PatchReproofResult,
} from '@walkz/contracts';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { recordAuditEvent } from './audit.js';
import { withTransaction } from './outbox.js';

const existingReproofRowSchema = z.object({
  result: z.unknown(),
}).strict();

export type PatchReproofRecordOutcome = 'applied' | 'unchanged' | 'conflict';

export interface PatchReproofRecordResult {
  outcome: PatchReproofRecordOutcome;
  result: PatchReproofResult | null;
}

function sameResult(left: PatchReproofResult, right: PatchReproofResult): boolean {
  return isDeepStrictEqual(left, right);
}

async function findRecordedResult(
  client: Pick<PoolClient, 'query'>,
  proposalId: string,
  attempt: number,
): Promise<PatchReproofResult | null> {
  const query = await client.query(
    `
      SELECT reproof_result AS result
      FROM evidence
      WHERE evidence_kind = 'patch_reproof'
        AND patch_proposal_id = $1
        AND reproof_attempt = $2
      LIMIT 1
    `,
    [proposalId, attempt],
  );
  const row = query.rows[0];
  return row === undefined
    ? null
    : parsePatchReproofResult(existingReproofRowSchema.parse(row).result);
}

async function recordReproofAudit(
  client: Pick<PoolClient, 'query'>,
  result: PatchReproofResult,
  outcome: 'accepted' | 'rejected',
  eventType: string,
  summary: string,
): Promise<void> {
  await recordAuditEvent(client, {
    actorUserId: null,
    eventType,
    summary,
    metadata: {
      operation: 'record_patch_reproof',
      outcome,
      subjectId: result.proposalId,
    },
  });
}

function resultSummary(result: PatchReproofResult): string {
  const regressionCount = result.regressions.length;
  const suffix = regressionCount === 1
    ? '1 regression check.'
    : `${regressionCount} regression checks.`;
  return `Approved patch reproof was ${result.outcome}; ${suffix}`;
}

function artifactHashes(result: PatchReproofResult): string[] {
  return [result.proof, ...result.regressions]
    .flatMap((check) => check.artifacts.map((artifact) => artifact.sha256));
}

export async function recordPatchReproofResult(
  pool: Pick<Pool, 'connect'>,
  input: unknown,
): Promise<PatchReproofRecordResult> {
  const result = parsePatchReproofResult(input);
  return withTransaction(pool, async (client) => {
    const lockedProposal = await client.query(
      'SELECT id FROM patch_proposals WHERE id = $1 FOR UPDATE',
      [result.proposalId],
    );
    if (lockedProposal.rows.length !== 1) {
      await recordReproofAudit(
        client,
        result,
        'rejected',
        'patch_proposal.reproof_conflict',
        'A patch reproof result did not match a durable patch proposal.',
      );
      return { outcome: 'conflict', result: null };
    }
    const existing = await findRecordedResult(
      client,
      result.proposalId,
      result.attempt,
    );
    if (existing !== null) {
      const unchanged = sameResult(existing, result);
      await recordReproofAudit(
        client,
        result,
        unchanged ? 'accepted' : 'rejected',
        unchanged
          ? 'patch_proposal.reproof_unchanged'
          : 'patch_proposal.reproof_conflict',
        unchanged
          ? 'The patch reproof result was already recorded.'
          : 'A different patch reproof result already owns this attempt.',
      );
      return {
        outcome: unchanged ? 'unchanged' : 'conflict',
        result: existing,
      };
    }

    const eligible = await client.query(
      `
        SELECT pp.id
        FROM patch_proposals pp
        JOIN review_runs rr ON rr.id = pp.review_run_id
        JOIN pull_requests pr ON pr.id = rr.pull_request_id
        JOIN findings f
          ON f.id = pp.finding_id AND f.review_run_id = pp.review_run_id
        WHERE pp.id = $1
          AND pp.review_run_id = $2
          AND pp.finding_id = $3
          AND pp.patch_hash = $4
          AND pp.head_sha = $5
          AND pp.approval_status = 'approved'
          AND pp.decided_by_user_id IS NOT NULL
          AND pp.stale_at IS NULL
          AND pr.head_sha = pp.head_sha
          AND rr.status IN ('awaiting_human', 'reproving')
          AND f.lifecycle_status = 'verified'
          AND f.evidence_level = 'VERIFIED'
        FOR UPDATE OF rr, pr, f
      `,
      [
        result.proposalId,
        result.reviewRunId,
        result.findingId,
        result.patchHash,
        result.headSha,
      ],
    );
    if (eligible.rows.length !== 1) {
      await recordReproofAudit(
        client,
        result,
        'rejected',
        'patch_proposal.reproof_conflict',
        'A patch reproof result failed its approval, revision, or evidence gate.',
      );
      return { outcome: 'conflict', result: null };
    }

    const checks = [result.proof, ...result.regressions];
    const durationMs = checks.reduce((total, check) => total + check.durationMs, 0);
    await client.query(
      `
        INSERT INTO evidence (
          finding_id, evidence_kind, command_digest, head_exit_code,
          duration_ms, sanitized_summary, artifact_hashes,
          review_run_id, patch_proposal_id, patch_hash, head_sha,
          reproof_attempt, reproof_outcome, reproof_result
        ) VALUES (
          $1, 'patch_reproof', $2, $3, $4, $5, $6::jsonb,
          $7, $8, $9, $10, $11, $12, $13::jsonb
        )
      `,
      [
        result.findingId,
        result.proof.commandDigest,
        result.proof.exitCode,
        durationMs,
        resultSummary(result),
        JSON.stringify(artifactHashes(result)),
        result.reviewRunId,
        result.proposalId,
        result.patchHash,
        result.headSha,
        result.attempt,
        result.outcome,
        JSON.stringify(result),
      ],
    );
    await recordReproofAudit(
      client,
      result,
      'accepted',
      `patch_proposal.reproof_${result.outcome}`,
      `Walkz recorded a ${result.outcome} patch reproof result.`,
    );
    return { outcome: 'applied', result };
  });
}
