import { z } from 'zod';

const pullRequestEventSchema = z
  .object({
    action: z.enum(['opened', 'ready_for_review', 'synchronize', 'closed']),
    pull_request: z
      .object({
        number: z.number().int().positive(),
        base: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }).strict(),
        head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }).strict(),
      })
      .strict(),
  })
  .strict();

export interface PullRequestReviewTrigger {
  trigger: 'ready_for_review' | 'synchronize';
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
}

export function parsePullRequestReviewTrigger(input: unknown): PullRequestReviewTrigger | null {
  const event = pullRequestEventSchema.parse(input);
  if (event.action === 'ready_for_review') {
    return {
      trigger: 'ready_for_review',
      pullRequestNumber: event.pull_request.number,
      baseSha: event.pull_request.base.sha,
      headSha: event.pull_request.head.sha,
    };
  }
  if (event.action === 'synchronize') {
    return {
      trigger: 'synchronize',
      pullRequestNumber: event.pull_request.number,
      baseSha: event.pull_request.base.sha,
      headSha: event.pull_request.head.sha,
    };
  }
  return null;
}
