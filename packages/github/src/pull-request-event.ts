import { z } from 'zod';

const githubIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);

const pullRequestEventSchema = z
  .object({
    action: z.string().trim().min(1).max(128),
    installation: z.object({ id: githubIdSchema }),
    repository: z.object({
      id: githubIdSchema,
      name: z.string().trim().min(1).max(100),
      owner: z.object({ login: z.string().trim().min(1).max(100) }),
    }),
    pull_request: z
      .object({
        id: githubIdSchema,
        number: z.number().int().positive(),
        base: z.object({ sha: shaSchema }),
        head: z.object({ sha: shaSchema }),
      })
      .refine((pullRequest) => pullRequest.base.sha !== pullRequest.head.sha, {
        message: 'Pull request base and head commits must differ.',
        path: ['head', 'sha'],
      }),
  })
  .strip();

export interface PullRequestReviewTrigger {
  trigger: 'ready_for_review' | 'synchronize';
  installationId: string;
  repositoryId: string;
  repositoryOwner: string;
  repositoryName: string;
  pullRequestId: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
}

export function parsePullRequestReviewTrigger(input: unknown): PullRequestReviewTrigger | null {
  const event = pullRequestEventSchema.parse(input);
  if (event.action === 'ready_for_review') {
    return {
      trigger: 'ready_for_review',
      installationId: String(event.installation.id),
      repositoryId: String(event.repository.id),
      repositoryOwner: event.repository.owner.login,
      repositoryName: event.repository.name,
      pullRequestId: String(event.pull_request.id),
      pullRequestNumber: event.pull_request.number,
      baseSha: event.pull_request.base.sha,
      headSha: event.pull_request.head.sha,
    };
  }
  if (event.action === 'synchronize') {
    return {
      trigger: 'synchronize',
      installationId: String(event.installation.id),
      repositoryId: String(event.repository.id),
      repositoryOwner: event.repository.owner.login,
      repositoryName: event.repository.name,
      pullRequestId: String(event.pull_request.id),
      pullRequestNumber: event.pull_request.number,
      baseSha: event.pull_request.base.sha,
      headSha: event.pull_request.head.sha,
    };
  }
  return null;
}
