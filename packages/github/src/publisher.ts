import { z } from 'zod';

import {
  parseReviewCheckPayload,
  type ReviewCheckPayload,
} from './checks.js';

const repositoryTargetSchema = z
  .object({
    owner: z.string().trim().min(1).max(100),
    repository: z.string().trim().min(1).max(100),
  })
  .strict();

export interface GitHubChecksClient {
  create(input: {
    owner: string;
    repo: string;
    name: string;
    headSha: string;
    status: 'queued' | 'in_progress' | 'completed';
    conclusion: ReviewCheckPayload['conclusion'];
    summary: string;
    annotations: ReviewCheckPayload['annotations'];
  }): Promise<{ id: number }>;
}

export interface ReviewCheckPublisher {
  publish(target: unknown, payload: unknown): Promise<number>;
}

export function createReviewCheckPublisher(
  client: GitHubChecksClient,
): ReviewCheckPublisher {
  return {
    async publish(target, payload) {
      const repository = repositoryTargetSchema.parse(target);
      const check = parseReviewCheckPayload(payload);
      const result = await client.create({
        owner: repository.owner,
        repo: repository.repository,
        name: check.name,
        headSha: check.headSha,
        status: check.status,
        conclusion: check.conclusion,
        summary: check.summary,
        annotations: check.annotations,
      });
      return result.id;
    },
  };
}
