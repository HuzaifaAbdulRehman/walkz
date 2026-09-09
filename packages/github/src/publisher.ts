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

const idempotencyKeySchema = z.string().trim().min(1).max(255);

export interface GitHubChecksClient {
  findByExternalId(input: {
    owner: string;
    repo: string;
    name: string;
    headSha: string;
    externalId: string;
  }): Promise<{ id: number } | null>;
  create(input: {
    owner: string;
    repo: string;
    name: string;
    headSha: string;
    status: 'queued' | 'in_progress' | 'completed';
    conclusion: ReviewCheckPayload['conclusion'];
    summary: string;
    annotations: ReviewCheckPayload['annotations'];
    externalId: string;
  }): Promise<{ id: number }>;
  update(input: {
    owner: string;
    repo: string;
    checkRunId: number;
    name: string;
    status: 'queued' | 'in_progress' | 'completed';
    conclusion: ReviewCheckPayload['conclusion'];
    summary: string;
    annotations: ReviewCheckPayload['annotations'];
  }): Promise<{ id: number }>;
}

export interface ReviewCheckPublisher {
  publish(target: unknown, payload: unknown, idempotencyKey: unknown): Promise<number>;
}

export function createReviewCheckPublisher(
  client: GitHubChecksClient,
): ReviewCheckPublisher {
  return {
    async publish(target, payload, idempotencyKeyInput) {
      const repository = repositoryTargetSchema.parse(target);
      const check = parseReviewCheckPayload(payload);
      const externalId = idempotencyKeySchema.parse(idempotencyKeyInput);
      const existing = await client.findByExternalId({
        owner: repository.owner,
        repo: repository.repository,
        name: check.name,
        headSha: check.headSha,
        externalId,
      });
      if (existing !== null) {
        const result = await client.update({
          owner: repository.owner,
          repo: repository.repository,
          checkRunId: existing.id,
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
          summary: check.summary,
          annotations: check.annotations,
        });
        return result.id;
      }
      const result = await client.create({
        owner: repository.owner,
        repo: repository.repository,
        name: check.name,
        headSha: check.headSha,
        status: check.status,
        conclusion: check.conclusion,
        summary: check.summary,
        annotations: check.annotations,
        externalId,
      });
      return result.id;
    },
  };
}
