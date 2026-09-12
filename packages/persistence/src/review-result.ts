import { reviewRunStatusSchema } from '@walkz/contracts';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import {
  createGitHubCheckCompletedOutboxEvent,
  githubCheckCompletedOutboxEventSchema,
  githubCheckResultFindingSchema,
  githubCheckVerdictSchema,
  withTransaction,
} from './outbox.js';

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const proofOutcomeSchema = z.enum([
  'passed',
  'failed',
  'timed_out',
  'cancelled',
  'infrastructure_error',
]);
const counterfactualEvidenceSchema = z.object({
  kind: z.literal('counterfactual_proof'),
  planDigest: digestSchema,
  commandDigest: digestSchema,
  baseSha: shaSchema,
  headSha: shaSchema,
  baseOutcome: proofOutcomeSchema,
  headOutcome: proofOutcomeSchema,
  baseExitCode: z.number().int().nullable(),
  headExitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  sanitizedSummary: z.string().max(65_536),
  artifactHashes: z.array(digestSchema).max(64),
  recordedAt: z.string().datetime({ offset: true }),
}).strict();
const persistedFindingSchema = githubCheckResultFindingSchema.extend({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  category: z.enum([
    'correctness',
    'security',
    'performance',
    'reliability',
    'maintainability',
  ]),
  lifecycleStatus: z.enum([
    'proposed',
    'challenged',
    'proving',
    'verified',
    'supported',
    'unverified',
    'dismissed',
    'fixed',
  ]),
  evidenceLevel: z.enum(['VERIFIED', 'SUPPORTED', 'UNVERIFIED']),
  advisoryConfidence: z.number().min(0).max(1),
  claim: z.string().trim().min(1).max(2_000),
  failureMechanism: z.string().trim().min(1).max(4_000),
  suggestedProof: z.string().trim().min(1).max(4_000),
  evidence: z.array(counterfactualEvidenceSchema).max(8).default([]),
});

const completedReviewRunInputSchema = z
  .object({
    reviewRunId: z.uuid(),
    workerId: z.string().trim().min(1).max(128),
    baseSha: shaSchema,
    headSha: shaSchema,
    verdict: githubCheckVerdictSchema,
    summary: z.string().trim().min(1).max(65_536),
    findings: z.array(persistedFindingSchema).max(50),
  })
  .strict()
  .refine((result) => result.baseSha !== result.headSha, {
    message: 'Review results must compare different base and head commits.',
    path: ['headSha'],
  })
  .superRefine((result, context) => {
    result.findings.forEach((finding, findingIndex) => {
      for (const [evidenceIndex, evidence] of finding.evidence.entries()) {
        if (
          evidence.baseSha.toLowerCase() !== result.baseSha.toLowerCase() ||
          evidence.headSha.toLowerCase() !== result.headSha.toLowerCase()
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Finding evidence must match the review run revisions.',
            path: ['findings', findingIndex, 'evidence', evidenceIndex],
          });
        }
      }
      if (
        finding.evidenceLevel === 'VERIFIED' &&
        !finding.evidence.some((evidence) =>
          evidence.baseOutcome === 'passed' && evidence.headOutcome === 'failed')
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Verified findings require bound counterfactual evidence.',
          path: ['findings', findingIndex, 'evidence'],
        });
      }
    });
  });

const lockedReviewRunSchema = z
  .object({
    id: z.uuid(),
    status: reviewRunStatusSchema,
    baseSha: shaSchema,
    headSha: shaSchema,
    installationId: z.string(),
    owner: z.string(),
    repository: z.string(),
    workerLeaseOwner: z.string().nullable(),
  })
  .strict();

const existingEventSchema = z
  .object({
    id: z.uuid(),
    payload: z.unknown(),
  })
  .strict();

export interface CompletedHostedReviewRun {
  reviewRunId: string;
  outboxEventId: string;
  created: boolean;
}

function terminalStatusForVerdict(
  verdict: z.infer<typeof githubCheckVerdictSchema>,
  hasVerifiedFinding: boolean,
): 'awaiting_human' | 'completed' | 'inconclusive' | 'failed' {
  if (verdict === 'INCONCLUSIVE') return 'inconclusive';
  if (verdict === 'ERROR') return 'failed';
  if (verdict === 'FIX' && hasVerifiedFinding) return 'awaiting_human';
  return 'completed';
}

function samePayload(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function lockReviewRun(
  client: Pick<PoolClient, 'query'>,
  reviewRunId: string,
) {
  const result = await client.query(
    `
      SELECT rr.id,
             rr.status,
             rr.base_sha AS "baseSha",
             rr.head_sha AS "headSha",
             gi.github_id::text AS "installationId",
             r.owner_login AS owner,
             r.repository_name AS repository
             , rr.worker_lease_owner AS "workerLeaseOwner"
      FROM review_runs rr
      JOIN repositories r ON r.id = rr.repository_id
      JOIN github_installations gi ON gi.id = r.installation_id
      WHERE rr.id = $1
      FOR UPDATE OF rr
    `,
    [reviewRunId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Review run was not found.');
  }
  return lockedReviewRunSchema.parse(row);
}

async function findCompletedEvent(
  client: Pick<PoolClient, 'query'>,
  reviewRunId: string,
) {
  const result = await client.query(
    `
      SELECT id, payload
      FROM outbox_events
      WHERE aggregate_id = $1 AND event_type = 'github_check.completed'
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [reviewRunId],
  );
  const row = result.rows[0];
  return row === undefined ? null : existingEventSchema.parse(row);
}

async function persistFindings(
  client: Pick<PoolClient, 'query'>,
  reviewRunId: string,
  findings: z.infer<typeof persistedFindingSchema>[],
): Promise<void> {
  if (findings.length === 0) return;
  const inserted = await client.query(
    `
      INSERT INTO findings (
        review_run_id, fingerprint, lifecycle_status, evidence_level,
        summary, category, severity, file_path, start_line, end_line,
        claim, failure_mechanism, suggested_proof, advisory_confidence
      )
      SELECT $1,
             item.fingerprint,
             item."lifecycleStatus",
             item."evidenceLevel",
             item.summary,
             item.category,
             item.severity,
             item.path,
             item."startLine",
             item."endLine",
             item.claim,
             item."failureMechanism",
             item."suggestedProof",
             item."advisoryConfidence"
      FROM jsonb_to_recordset($2::jsonb) AS item(
        fingerprint text,
        category text,
        severity text,
        path text,
        "startLine" integer,
        "endLine" integer,
        summary text,
        "lifecycleStatus" text,
        "evidenceLevel" text,
        "advisoryConfidence" double precision,
        claim text,
        "failureMechanism" text,
        "suggestedProof" text,
        evidence jsonb
      )
      RETURNING id, fingerprint
    `,
    [reviewRunId, JSON.stringify(findings)],
  );
  const findingIds = new Map<string, string>(
    inserted.rows.map((row) => [String(row.fingerprint), String(row.id)]),
  );
  const evidence = findings.flatMap((finding) =>
    finding.evidence.map((item) => ({
      findingId: findingIds.get(finding.fingerprint),
      ...item,
    })));
  if (evidence.length === 0) return;
  if (evidence.some((item) => item.findingId === undefined)) {
    throw new Error('Finding evidence could not be bound to its durable finding.');
  }
  await client.query(
    `
      INSERT INTO evidence (
        finding_id, evidence_kind, plan_digest, command_digest,
        base_outcome, head_outcome, base_exit_code, head_exit_code,
        duration_ms, sanitized_summary, artifact_hashes, created_at
      )
      SELECT item."findingId"::uuid,
             'counterfactual_proof',
             item."planDigest",
             item."commandDigest",
             item."baseOutcome",
             item."headOutcome",
             item."baseExitCode",
             item."headExitCode",
             item."durationMs",
             item."sanitizedSummary",
             item."artifactHashes",
             item."recordedAt"::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS item(
        "findingId" text,
        "planDigest" text,
        "commandDigest" text,
        "baseOutcome" text,
        "headOutcome" text,
        "baseExitCode" integer,
        "headExitCode" integer,
        "durationMs" integer,
        "sanitizedSummary" text,
        "artifactHashes" jsonb,
        "recordedAt" text
      )
    `,
    [JSON.stringify(evidence)],
  );
}

export async function completeHostedReviewRun(
  pool: Pick<Pool, 'connect'>,
  input: unknown,
): Promise<CompletedHostedReviewRun> {
  const result = completedReviewRunInputSchema.parse(input);
  return withTransaction(pool, async (client) => {
    const run = await lockReviewRun(client, result.reviewRunId);
    if (run.baseSha !== result.baseSha || run.headSha !== result.headSha) {
      throw new Error('Review result revisions do not match the durable review run.');
    }

    const event = githubCheckCompletedOutboxEventSchema.parse({
      aggregateId: run.id,
      eventType: 'github_check.completed',
      payload: {
        reviewRunId: run.id,
        installationId: run.installationId,
        owner: run.owner,
        repository: run.repository,
        baseSha: run.baseSha,
        headSha: run.headSha,
        verdict: result.verdict,
        summary: result.summary,
        findings: result.findings.map((finding) => ({
          path: finding.path,
          startLine: finding.startLine,
          endLine: finding.endLine,
          severity: finding.severity,
          summary: finding.summary,
        })),
      },
    });

    if (['awaiting_human', 'completed', 'inconclusive', 'failed'].includes(run.status)) {
      const existing = await findCompletedEvent(client, run.id);
      if (
        existing === null ||
        !samePayload(
          githubCheckCompletedOutboxEventSchema.parse({
            aggregateId: run.id,
            eventType: 'github_check.completed',
            payload: existing.payload,
          }).payload,
          event.payload,
        )
      ) {
        throw new Error('Review run already has a different terminal result.');
      }
      return { reviewRunId: run.id, outboxEventId: existing.id, created: false };
    }
    if (run.status === 'cancelled' || run.status === 'superseded') {
      throw new Error(`Cannot complete a ${run.status} review run.`);
    }
    if (run.workerLeaseOwner !== result.workerId) {
      throw new Error('Review run lease is not owned by this worker.');
    }

    const terminalStatus = terminalStatusForVerdict(
      result.verdict,
      result.findings.some((finding) => finding.evidenceLevel === 'VERIFIED'),
    );
    const updated = await client.query(
      `
        UPDATE review_runs
        SET status = $2,
            verdict = $3,
            result_summary = $4,
            completed_at = CASE WHEN $2 = 'awaiting_human' THEN NULL ELSE now() END,
            worker_lease_owner = NULL,
            worker_lease_expires_at = NULL
        WHERE id = $1 AND status = $5 AND worker_lease_owner = $6
        RETURNING id
      `,
      [
        run.id,
        terminalStatus,
        result.verdict,
        result.summary,
        run.status,
        result.workerId,
      ],
    );
    if (updated.rows.length !== 1) {
      throw new Error('Review run changed while its result was being stored.');
    }
    await persistFindings(client, run.id, result.findings);
    const outboxEventId = await createGitHubCheckCompletedOutboxEvent(client, event);
    return { reviewRunId: run.id, outboxEventId, created: true };
  });
}
