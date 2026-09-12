import { z } from 'zod';

import type {
  GitHubInstallationApp,
  OctokitRequestClient,
} from './octokit-checks.js';

const installationIdSchema = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(
  (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
  { message: 'Installation ID must be a safe JavaScript integer.' },
);
const githubIdSchema = z.number().int().positive().safe();
const targetSchema = z.object({
  owner: z.string().trim().min(1).max(100),
  repository: z.string().trim().min(1).max(100),
}).strict();
const authorizationInputSchema = targetSchema.extend({
  username: z.string().trim().min(1).max(100),
}).strict();
const permissionResponseSchema = z.object({
  permission: z.enum(['admin', 'write', 'read', 'none']),
}).passthrough();
const replyKindSchema = z.enum(['queued', 'proposal', 'denied', 'ignored', 'error']);
const replyInputSchema = targetSchema.extend({
  pullRequestNumber: z.number().int().positive(),
  commandCommentId: z.string().regex(/^[1-9][0-9]{0,18}$/),
  kind: replyKindSchema,
  summary: z.string().trim().min(1).max(4_000).refine(
    (value) => !value.includes('<!-- walkz-command:'),
    { message: 'Reply summaries cannot contain Walkz command markers.' },
  ),
}).strict();
const issueCommentSchema = z.object({
  id: githubIdSchema,
  body: z.string().max(65_536).nullable(),
  html_url: z.url(),
  performed_via_github_app: z.object({ id: githubIdSchema }).nullable().optional(),
}).passthrough();
const issueCommentsSchema = z.array(issueCommentSchema).max(100);

const commentsPerPage = 100;
const maximumCommentPages = 10;

export interface PublishedCommandReply {
  commentId: string;
  url: string;
  reused: boolean;
}

export class GitHubCommandReplyConflictError extends Error {
  constructor() {
    super('A conflicting Walkz reply already uses this command marker.');
    this.name = 'GitHubCommandReplyConflictError';
  }
}

export interface GitHubCommentCommandClient {
  canMaintain(input: unknown): Promise<boolean>;
  publishReply(input: unknown): Promise<PublishedCommandReply>;
}

export interface InstallationGitHubCommentCommandClientFactory {
  forInstallation(installationId: string): Promise<GitHubCommentCommandClient>;
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === 'object' && error !== null &&
    'status' in error && (error as { status?: unknown }).status === status;
}

function marker(input: z.infer<typeof replyInputSchema>): string {
  return `<!-- walkz-command:${input.commandCommentId}:${input.kind} -->`;
}

function replyBody(input: z.infer<typeof replyInputSchema>): string {
  return `${input.summary}\n\n${marker(input)}`;
}

async function findExistingReply(
  client: OctokitRequestClient,
  appId: number,
  input: z.infer<typeof replyInputSchema>,
): Promise<PublishedCommandReply | null> {
  const expectedMarker = marker(input);
  const expectedBody = replyBody(input);
  for (let page = 1; page <= maximumCommentPages; page += 1) {
    const response = await client.request(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      {
        owner: input.owner,
        repo: input.repository,
        issue_number: input.pullRequestNumber,
        per_page: commentsPerPage,
        page,
      },
    );
    const comments = issueCommentsSchema.parse(response.data);
    for (const comment of comments) {
      if (
        comment.performed_via_github_app?.id !== appId ||
        !comment.body?.includes(expectedMarker)
      ) {
        continue;
      }
      if (comment.body !== expectedBody) throw new GitHubCommandReplyConflictError();
      return {
        commentId: String(comment.id),
        url: comment.html_url,
        reused: true,
      };
    }
    if (comments.length < commentsPerPage) return null;
  }
  throw new Error('GitHub comment history exceeded the idempotency scan limit.');
}

export function createGitHubCommentCommandClient(
  client: OctokitRequestClient,
  appIdInput: unknown,
): GitHubCommentCommandClient {
  const appId = githubIdSchema.parse(appIdInput);
  return {
    async canMaintain(input) {
      const authorization = authorizationInputSchema.parse(input);
      try {
        const response = await client.request(
          'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
          {
            owner: authorization.owner,
            repo: authorization.repository,
            username: authorization.username,
          },
        );
        const permission = permissionResponseSchema.parse(response.data).permission;
        return permission === 'admin' || permission === 'write';
      } catch (error) {
        if (hasStatus(error, 404)) return false;
        throw error;
      }
    },
    async publishReply(input) {
      const reply = replyInputSchema.parse(input);
      const existing = await findExistingReply(client, appId, reply);
      if (existing !== null) return existing;
      const response = await client.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        {
          owner: reply.owner,
          repo: reply.repository,
          issue_number: reply.pullRequestNumber,
          body: replyBody(reply),
        },
      );
      const created = issueCommentSchema.parse(response.data);
      if (created.performed_via_github_app?.id !== appId) {
        throw new Error('GitHub did not attribute the command reply to this App.');
      }
      return {
        commentId: String(created.id),
        url: created.html_url,
        reused: false,
      };
    },
  };
}

export function createInstallationGitHubCommentCommandClientFactory(
  app: Pick<GitHubInstallationApp, 'getInstallationOctokit'>,
  appIdInput: unknown,
): InstallationGitHubCommentCommandClientFactory {
  const appId = githubIdSchema.parse(appIdInput);
  return {
    async forInstallation(installationIdInput) {
      const installationId = installationIdSchema.parse(installationIdInput);
      const client = await app.getInstallationOctokit(Number(installationId));
      return createGitHubCommentCommandClient(client, appId);
    },
  };
}
