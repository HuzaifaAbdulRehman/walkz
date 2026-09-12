import { z } from 'zod';

const githubIdSchema = z.number().int().positive().safe();
const loginSchema = z.string().trim().min(1).max(100);

const commentCommandEnvelopeSchema = z.object({
  action: z.string().trim().min(1).max(64),
}).passthrough();

const commentCommandPayloadSchema = z.object({
  action: z.literal('created'),
  installation: z.object({ id: githubIdSchema }),
  repository: z.object({
    id: githubIdSchema,
    name: z.string().trim().min(1).max(100),
    owner: z.object({ login: loginSchema }),
  }),
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.object({}).passthrough().optional(),
  }),
  comment: z.object({
    id: githubIdSchema,
    body: z.string().max(256 * 1_024),
    user: z.object({
      id: githubIdSchema,
      login: loginSchema,
      type: z.string().trim().min(1).max(64),
    }),
  }),
  sender: z.object({
    id: githubIdSchema,
    login: loginSchema,
    type: z.string().trim().min(1).max(64),
  }),
}).passthrough().superRefine((payload, context) => {
  if (
    payload.comment.user.id !== payload.sender.id ||
    payload.comment.user.login.toLowerCase() !== payload.sender.login.toLowerCase()
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Comment author must match the webhook sender.',
      path: ['sender'],
    });
  }
});

export type PullRequestCommentCommandName = 'review' | 'propose_fix';

export interface PullRequestCommentCommand {
  command: PullRequestCommentCommandName;
  installationId: string;
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  pullRequestNumber: number;
  commentId: string;
  commenterId: string;
  commenterLogin: string;
}

const commandPattern = /^@walkz-review[ \t]+(review|propose[ \t]+fix)$/i;

export function parsePullRequestCommentCommand(
  input: unknown,
): PullRequestCommentCommand | null {
  const envelope = commentCommandEnvelopeSchema.parse(input);
  if (envelope.action !== 'created') return null;

  const payload = commentCommandPayloadSchema.parse(input);
  if (
    payload.issue.pull_request === undefined ||
    payload.comment.user.type !== 'User' ||
    payload.sender.type !== 'User'
  ) {
    return null;
  }

  const match = commandPattern.exec(payload.comment.body.trim());
  if (match === null) return null;

  return {
    command: match[1]?.toLowerCase() === 'review' ? 'review' : 'propose_fix',
    installationId: String(payload.installation.id),
    repositoryId: String(payload.repository.id),
    repositoryOwner: payload.repository.owner.login,
    repositoryName: payload.repository.name,
    pullRequestNumber: payload.issue.number,
    commentId: String(payload.comment.id),
    commenterId: String(payload.comment.user.id),
    commenterLogin: payload.comment.user.login,
  };
}
