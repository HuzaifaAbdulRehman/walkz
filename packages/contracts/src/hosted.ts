import { z } from 'zod';

const sha1Schema = z.string().regex(/^[a-f0-9]{40}$/i);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const githubIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, {
    message: 'GitHub IDs must fit PostgreSQL BIGINT.',
  });

export const reviewRunStatusSchema = z.enum([
  'queued',
  'collecting_context',
  'deterministic_checks',
  'reviewing',
  'challenging',
  'proving',
  'awaiting_human',
  'fixing',
  'reproving',
  'completed',
  'inconclusive',
  'failed',
  'cancelled',
  'superseded',
]);

export const hostedReviewRunSchema = z
  .object({
    id: z.uuid(),
    repositoryId: z.uuid(),
    pullRequestId: z.uuid().nullable(),
    baseSha: sha1Schema,
    headSha: sha1Schema,
    configHash: sha256Schema,
    provider: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(512),
    promptVersion: z.string().trim().min(1).max(128),
    status: reviewRunStatusSchema,
  })
  .strict()
  .refine((run) => run.baseSha !== run.headSha, {
    message: 'Hosted review runs must compare distinct revisions.',
    path: ['headSha'],
  });

export type GithubId = z.infer<typeof githubIdSchema>;
export type HostedReviewRun = z.infer<typeof hostedReviewRunSchema>;
export type ReviewRunStatus = z.infer<typeof reviewRunStatusSchema>;

const terminalReviewRunStatuses = new Set<ReviewRunStatus>([
  'completed',
  'inconclusive',
  'failed',
  'cancelled',
  'superseded',
]);

export function parseGithubId(input: unknown): GithubId {
  return githubIdSchema.parse(input);
}

export function parseHostedReviewRun(input: unknown): HostedReviewRun {
  return hostedReviewRunSchema.parse(input);
}

export function isTerminalReviewRunStatus(status: ReviewRunStatus): boolean {
  return terminalReviewRunStatuses.has(status);
}

export function canTransitionReviewRun(
  from: ReviewRunStatus,
  to: ReviewRunStatus,
): boolean {
  return from === to || !isTerminalReviewRunStatus(from);
}
