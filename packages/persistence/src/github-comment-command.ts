import type { Pool } from 'pg';
import { z } from 'zod';

const githubIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/).refine(
  (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
  { message: 'GitHub IDs must fit PostgreSQL BIGINT.' },
);
const leaseSchema = z.object({
  commandId: z.uuid(),
  workerId: z.string().trim().min(1).max(128),
  leaseMs: z.number().int().min(10_000).max(60 * 60 * 1_000),
}).strict();
const ownerSchema = leaseSchema.omit({ leaseMs: true });
const failureSchema = ownerSchema.extend({ replyUrl: z.url().max(512).optional() }).strict();
const completionSchema = ownerSchema.extend({
  status: z.enum(['completed', 'denied', 'ignored']),
  replyUrl: z.url().max(512),
  reviewRunId: z.uuid().nullable().default(null),
  patchProposalId: z.uuid().nullable().default(null),
}).strict();
const claimedCommandSchema = z.object({
  commandId: z.uuid(),
  repositoryId: z.uuid(),
  installationId: githubIdSchema,
  repositoryGitHubId: githubIdSchema,
  owner: z.string().trim().min(1).max(100),
  repository: z.string().trim().min(1).max(100),
  commentId: githubIdSchema,
  commenterId: githubIdSchema,
  commenterLogin: z.string().trim().min(1).max(100),
  pullRequestNumber: z.number().int().positive(),
  command: z.enum(['review', 'propose_fix']),
  patchProposalId: z.uuid().nullable(),
  proposalReviewRunId: z.uuid().nullable(),
  proposalHeadSha: z.string().regex(/^[a-f0-9]{40}$/i).nullable(),
  attempt: z.number().int().positive(),
}).strict().superRefine((command, context) => {
  const linked = [
    command.patchProposalId,
    command.proposalReviewRunId,
    command.proposalHeadSha,
  ];
  if (linked.some((value) => value !== null) && linked.some((value) => value === null)) {
    context.addIssue({
      code: 'custom',
      message: 'Linked proposal metadata must be present together.',
      path: ['patchProposalId'],
    });
  }
});

export type ClaimedGitHubCommentCommand = z.infer<typeof claimedCommandSchema>;

export async function claimGitHubCommentCommand(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<ClaimedGitHubCommentCommand | null> {
  const input = leaseSchema.parse(inputValue);
  const result = await pool.query(
    `UPDATE github_comment_commands gcc
     SET status = 'processing',
         attempt = attempt + 1,
         lease_owner = $2,
         lease_expires_at = now() + ($3 * interval '1 millisecond'),
         updated_at = now()
     FROM repositories r, github_installations gi
     WHERE gcc.id = $1
       AND gcc.repository_id = r.id
       AND r.installation_id = gi.id
       AND gcc.attempt < 5
       AND (
         gcc.status = 'queued' OR (
           gcc.status = 'processing' AND
           (gcc.lease_expires_at IS NULL OR gcc.lease_expires_at <= now())
         )
       )
     RETURNING gcc.id AS "commandId",
               gcc.repository_id AS "repositoryId",
               gi.github_id::text AS "installationId",
               r.github_id::text AS "repositoryGitHubId",
               r.owner_login AS owner,
               r.repository_name AS repository,
               gcc.github_comment_id::text AS "commentId",
               gcc.commenter_github_id::text AS "commenterId",
               gcc.commenter_login AS "commenterLogin",
               gcc.pull_request_number AS "pullRequestNumber",
               gcc.command,
               gcc.patch_proposal_id AS "patchProposalId",
               (SELECT pp.review_run_id FROM patch_proposals pp
                 WHERE pp.id = gcc.patch_proposal_id) AS "proposalReviewRunId",
               (SELECT pp.head_sha FROM patch_proposals pp
                 WHERE pp.id = gcc.patch_proposal_id) AS "proposalHeadSha",
               gcc.attempt`,
    [input.commandId, input.workerId, input.leaseMs],
  );
  return result.rows[0] === undefined
    ? null
    : claimedCommandSchema.parse(result.rows[0]);
}

export async function renewGitHubCommentCommandLease(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<boolean> {
  const input = leaseSchema.parse(inputValue);
  const result = await pool.query(
    `UPDATE github_comment_commands
     SET lease_expires_at = now() + ($3 * interval '1 millisecond')
     WHERE id = $1 AND lease_owner = $2 AND status = 'processing'
     RETURNING id`,
    [input.commandId, input.workerId, input.leaseMs],
  );
  return result.rows.length === 1;
}

export async function releaseGitHubCommentCommand(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<boolean> {
  const input = ownerSchema.parse(inputValue);
  const result = await pool.query(
    `UPDATE github_comment_commands
     SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'processing' AND attempt < 5
     RETURNING id`,
    [input.commandId, input.workerId],
  );
  return result.rows.length === 1;
}

export async function completeGitHubCommentCommand(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<boolean> {
  const input = completionSchema.parse(inputValue);
  const resultTargets = [input.reviewRunId, input.patchProposalId]
    .filter((value) => value !== null).length;
  if ((input.status === 'completed' && resultTargets !== 1) ||
      (input.status !== 'completed' && resultTargets !== 0)) {
    throw new Error('Command completion must reference exactly one matching result.');
  }
  const result = await pool.query(
    `UPDATE github_comment_commands
     SET status = $3, reply_url = $4, review_run_id = $5,
         patch_proposal_id = $6,
         lease_owner = NULL, lease_expires_at = NULL,
         updated_at = now(), completed_at = now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'processing'
     RETURNING id`,
    [
      input.commandId,
      input.workerId,
      input.status,
      input.replyUrl,
      input.reviewRunId,
      input.patchProposalId,
    ],
  );
  return result.rows.length === 1;
}

export async function failGitHubCommentCommand(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<boolean> {
  const input = failureSchema.parse(inputValue);
  const result = await pool.query(
    `UPDATE github_comment_commands
     SET status = 'failed', failure_code = 'workflow_failed',
         reply_url = COALESCE($3, reply_url),
         lease_owner = NULL, lease_expires_at = NULL,
         updated_at = now(), completed_at = now()
     WHERE id = $1 AND lease_owner = $2 AND status = 'processing'
     RETURNING id`,
    [input.commandId, input.workerId, input.replyUrl ?? null],
  );
  return result.rows.length === 1;
}

export async function listRecoverableGitHubCommentCommandIds(
  pool: Pick<Pool, 'query'>,
  inputValue: unknown,
): Promise<string[]> {
  const limit = z.number().int().min(1).max(1_000).parse(inputValue);
  const result = await pool.query<{ commandId: string }>(
    `SELECT id AS "commandId"
     FROM github_comment_commands
     WHERE attempt < 5
       AND (
         status = 'queued' OR (
           status = 'processing' AND
           (lease_expires_at IS NULL OR lease_expires_at <= now())
         )
       )
     ORDER BY updated_at ASC, id ASC
     LIMIT $1`,
    [limit],
  );
  return z.array(z.object({ commandId: z.uuid() }).strict())
    .parse(result.rows)
    .map((row) => row.commandId);
}
