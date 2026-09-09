import { createHash } from 'node:crypto';

import { parseWalkzConfig } from '@walkz/contracts';
import type { Pool } from 'pg';
import { z } from 'zod';

const leaseSchema = z.object({
  reviewRunId: z.uuid(),
  workerId: z.string().trim().min(1).max(128),
  leaseMs: z.number().int().min(10_000).max(60 * 60 * 1_000),
}).strict();
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const claimedSchema = z.object({
  reviewRunId: z.uuid(),
  repositoryId: z.uuid(),
  installationId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  owner: z.string().trim().min(1).max(100),
  repository: z.string().trim().min(1).max(100),
  pullRequestNumber: z.number().int().positive(),
  baseSha: shaSchema,
  headSha: shaSchema,
  configHash: z.string().regex(/^[a-f0-9]{64}$/i),
  config: z.unknown(),
  provider: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(512),
  promptVersion: z.string().trim().min(1).max(128),
  status: z.literal('collecting_context'),
}).strict();

export interface ClaimedHostedReviewRun {
  reviewRunId: string;
  repositoryId: string;
  installationId: string;
  owner: string;
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  configHash: string;
  config: ReturnType<typeof parseWalkzConfig>;
  provider: string;
  model: string;
  promptVersion: string;
  status: 'collecting_context';
}

export async function claimHostedReviewRun(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<ClaimedHostedReviewRun | null> {
  const lease = leaseSchema.parse(input);
  const result = await pool.query(
    `UPDATE review_runs rr
     SET status = 'collecting_context',
         worker_lease_owner = $2,
         worker_lease_expires_at = now() + ($3 * interval '1 millisecond'),
         worker_attempts = worker_attempts + 1
     FROM repositories r,
          github_installations gi,
          repository_configs rc,
          pull_requests pr
     WHERE rr.id = $1
       AND r.id = rr.repository_id
       AND gi.id = r.installation_id
       AND rc.id = rr.config_id
       AND pr.id = rr.pull_request_id
       AND (
         rr.status = 'queued' OR (
           rr.status = ANY($4::text[])
           AND (
             rr.worker_lease_expires_at IS NULL OR
             rr.worker_lease_expires_at <= now()
           )
         )
       )
     RETURNING rr.id AS "reviewRunId",
               rr.repository_id AS "repositoryId",
               gi.github_id::text AS "installationId",
               r.owner_login AS owner,
               r.repository_name AS repository,
               pr.number AS "pullRequestNumber",
               rr.base_sha AS "baseSha",
               rr.head_sha AS "headSha",
               rr.config_hash AS "configHash",
               rc.config,
               rr.provider,
               rr.model,
               rr.prompt_version AS "promptVersion",
               rr.status`,
    [
      lease.reviewRunId,
      lease.workerId,
      lease.leaseMs,
      ['collecting_context', 'deterministic_checks', 'reviewing', 'challenging', 'proving', 'reproving'],
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const claimed = claimedSchema.parse(row);
  const config = parseWalkzConfig(claimed.config);
  const configHash = createHash('sha256')
    .update(JSON.stringify(config), 'utf8')
    .digest('hex');
  if (configHash !== claimed.configHash) {
    throw new Error('Review run configuration does not match its immutable hash.');
  }
  if (
    claimed.provider !== config.provider.name ||
    claimed.model !== config.provider.model
  ) {
    throw new Error('Review run provider does not match its immutable configuration.');
  }
  return {
    ...claimed,
    config,
  };
}

export async function renewHostedReviewRunLease(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<boolean> {
  const lease = leaseSchema.parse(input);
  const result = await pool.query(
    `UPDATE review_runs
     SET worker_lease_expires_at = now() + ($3 * interval '1 millisecond')
     WHERE id = $1
       AND worker_lease_owner = $2
       AND status = ANY($4::text[])
     RETURNING id`,
    [
      lease.reviewRunId,
      lease.workerId,
      lease.leaseMs,
      ['collecting_context', 'deterministic_checks', 'reviewing', 'challenging', 'proving', 'reproving'],
    ],
  );
  return result.rows.length === 1;
}

export async function listRecoverableHostedReviewRunIds(
  pool: Pick<Pool, 'query'>,
  input: unknown,
): Promise<string[]> {
  const limit = z.number().int().min(1).max(1_000).parse(input);
  const result = await pool.query<{ reviewRunId: string }>(
    `SELECT id AS "reviewRunId"
     FROM review_runs
     WHERE status = 'queued' OR (
       status = ANY($2::text[])
       AND (
         worker_lease_expires_at IS NULL OR
         worker_lease_expires_at <= now()
       )
     )
     ORDER BY created_at ASC
     LIMIT $1`,
    [
      limit,
      ['collecting_context', 'deterministic_checks', 'reviewing', 'challenging', 'proving', 'reproving'],
    ],
  );
  return z.array(z.object({ reviewRunId: z.uuid() }).strict())
    .parse(result.rows)
    .map((row) => row.reviewRunId);
}
