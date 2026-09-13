import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  parseFindingFeedbackRequest,
  repositoryConfigSchema,
} from '@walkz/contracts';
import type { RecordFindingFeedbackResult } from '@walkz/persistence';

const repositoryParamsSchema = z.object({ repositoryId: z.uuid() }).strict();
const reviewParamsSchema = z.object({
  repositoryId: z.uuid(),
  reviewRunId: z.uuid(),
}).strict();
const findingParamsSchema = reviewParamsSchema.extend({
  findingId: z.uuid(),
}).strict();

const dashboardFindingSchema = z.object({
  id: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  category: z.enum([
    'correctness',
    'security',
    'performance',
    'reliability',
    'maintainability',
  ]).nullable(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).nullable(),
  path: z.string().nullable(),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
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
  advisoryConfidence: z.number().min(0).max(1).nullable(),
  summary: z.string(),
  claim: z.string().nullable(),
  failureMechanism: z.string().nullable(),
  suggestedProof: z.string().nullable(),
  createdAt: z.union([z.date(), z.string().datetime({ offset: true })]),
}).strict();

interface DashboardConfiguration {
  id: string;
  schemaVersion: number;
  configHash: string;
  createdAt: string;
  provider: {
    name: 'groq';
    model: string;
  };
  budget: {
    diffBytes: number;
    files: number;
    tokens: number;
    commandTimeoutMs: number;
    commandOutputBytesPerStream: number;
  };
  triggerPolicy: 'manual' | 'ready_for_review' | 'every_push';
  blockingEvidenceLevels: Array<'VERIFIED' | 'SUPPORTED'>;
  commandApprovalPolicy: 'prompt' | 'trusted_config';
  commandCount: number;
  requiredCommandCount: number;
  premiumEnabled: false;
  spendingLimitUsd: 0;
}

function mapDashboardConfiguration(input: unknown): DashboardConfiguration {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Stored configuration history was invalid.');
  }
  const value = input as Record<string, unknown>;
  const createdAt = value.createdAt instanceof Date
    ? value.createdAt.toISOString()
    : value.createdAt;
  if (
    typeof value.id !== 'string' ||
    typeof value.schemaVersion !== 'number' ||
    !Number.isInteger(value.schemaVersion) ||
    typeof value.configHash !== 'string' ||
    typeof createdAt !== 'string'
  ) {
    throw new Error('Stored configuration history was invalid.');
  }
  const config = repositoryConfigSchema.safeParse(value.config);
  if (!config.success) {
    throw new Error('Stored configuration history was invalid.');
  }
  return {
    id: value.id,
    schemaVersion: value.schemaVersion,
    configHash: value.configHash,
    createdAt,
    provider: config.data.provider,
    budget: {
      diffBytes: config.data.diffBudgetBytes,
      files: config.data.fileBudget,
      tokens: config.data.tokenBudget,
      commandTimeoutMs: config.data.commandTimeoutMs,
      commandOutputBytesPerStream: config.data.commandOutputBytesPerStream,
    },
    triggerPolicy: config.data.triggerPolicy,
    blockingEvidenceLevels: config.data.blockingEvidenceLevels,
    commandApprovalPolicy: config.data.commandApprovalPolicy,
    commandCount: config.data.commands.length,
    requiredCommandCount: config.data.commands.filter((command) => command.required).length,
    premiumEnabled: config.data.premiumEnabled,
    spendingLimitUsd: config.data.spendingLimitUsd,
  };
}

export interface RepositoryConfigHistoryStore {
  list(repositoryId: string): Promise<readonly unknown[]>;
}

export interface ReviewHistoryStore {
  list(repositoryId: string): Promise<readonly unknown[]>;
}

export interface ReviewFindingsStore {
  list(repositoryId: string, reviewRunId: string): Promise<readonly unknown[]>;
  recordFeedback(input: {
    requestId: string;
    repositoryId: string;
    reviewRunId: string;
    findingId: string;
    actorUserId: string;
    assessment: 'correct' | 'false_positive';
    reason: 'incorrect_claim' | 'intentional_behavior' | 'not_actionable' |
      'duplicate' | 'other' | null;
  }): Promise<RecordFindingFeedbackResult>;
}

export interface RepositoryApiAuthenticator {
  authenticate(request: unknown): Promise<{
    userId: string;
    repositoryIds: readonly string[];
  } | null>;
}

export interface RepositoryApiOptions {
  configHistory: RepositoryConfigHistoryStore;
  reviewHistory: ReviewHistoryStore;
  reviewFindings: ReviewFindingsStore;
  authenticator: RepositoryApiAuthenticator;
}

export function registerRepositoryRoutes(
  app: FastifyInstance,
  options: RepositoryApiOptions,
): void {
  app.get('/api/repositories/:repositoryId/configs', async (request, reply) => {
    const { repositoryId } = repositoryParamsSchema.parse(request.params);
    const identity = await options.authenticator.authenticate(request);
    if (identity === null) return reply.code(401).send({ error: 'authentication_required' });
    if (!identity.repositoryIds.includes(repositoryId)) {
      return reply.code(403).send({ error: 'repository_forbidden' });
    }
    const configurations = await options.configHistory.list(repositoryId);
    return reply.send({ configurations: configurations.map(mapDashboardConfiguration) });
  });
  app.get('/api/repositories/:repositoryId/reviews', async (request, reply) => {
    const { repositoryId } = repositoryParamsSchema.parse(request.params);
    const identity = await options.authenticator.authenticate(request);
    if (identity === null) return reply.code(401).send({ error: 'authentication_required' });
    if (!identity.repositoryIds.includes(repositoryId)) {
      return reply.code(403).send({ error: 'repository_forbidden' });
    }
    return reply.send({ reviews: await options.reviewHistory.list(repositoryId) });
  });
  app.get(
    '/api/repositories/:repositoryId/reviews/:reviewRunId/findings',
    async (request, reply) => {
      const { repositoryId, reviewRunId } = reviewParamsSchema.parse(request.params);
      const identity = await options.authenticator.authenticate(request);
      if (identity === null) {
        return reply.code(401).send({ error: 'authentication_required' });
      }
      if (!identity.repositoryIds.includes(repositoryId)) {
        return reply.code(403).send({ error: 'repository_forbidden' });
      }
      const findings = await options.reviewFindings.list(repositoryId, reviewRunId);
      return reply.send({
        findings: findings.map((finding) => {
          const parsed = dashboardFindingSchema.parse(finding);
          return {
            ...parsed,
            createdAt: parsed.createdAt instanceof Date
              ? parsed.createdAt.toISOString()
              : parsed.createdAt,
          };
        }),
      });
    },
  );
  app.post(
    '/api/repositories/:repositoryId/reviews/:reviewRunId/findings/:findingId/feedback',
    async (request, reply) => {
      const params = findingParamsSchema.parse(request.params);
      const identity = await options.authenticator.authenticate(request);
      if (identity === null) {
        return reply.code(401).send({ error: 'authentication_required' });
      }
      if (!identity.repositoryIds.includes(params.repositoryId)) {
        return reply.code(403).send({ error: 'repository_forbidden' });
      }
      const feedback = parseFindingFeedbackRequest(request.body);
      const result = await options.reviewFindings.recordFeedback({
        ...params,
        ...feedback,
        actorUserId: identity.userId,
      });
      if (result.feedback === null) {
        return result.outcome === 'not_found'
          ? reply.code(404).send({ error: 'finding_not_found' })
          : reply.code(409).send({ error: 'feedback_conflict' });
      }
      return reply.code(result.outcome === 'created' ? 201 : 200).send({
        outcome: result.outcome,
        feedback: {
          assessment: result.feedback.assessment,
          reason: result.feedback.reason,
          createdAt: result.feedback.createdAt.toISOString(),
        },
      });
    },
  );
}

export function createRepositoryApi(options: RepositoryApiOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  registerRepositoryRoutes(app, options);
  return app;
}
