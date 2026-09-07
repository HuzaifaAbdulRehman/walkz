import { randomUUID } from 'node:crypto';

import {
  parseWalkzConfig,
  validateReviewRequest,
  type LocalReviewBudget,
  type LocalReviewRun,
  type RepositoryConfig,
  type ReviewRequest,
} from '@walkz/contracts';

export interface CreateLocalReviewRunOptions {
  clock?: () => Date;
  runIdFactory?: () => string;
}

export function createLocalReviewRun(
  requestInput: unknown,
  configInput: unknown,
  options: CreateLocalReviewRunOptions = {},
): LocalReviewRun {
  const request = validateReviewRequest(requestInput);
  const config = parseWalkzConfig(configInput);
  if (request.configVersion !== config.schemaVersion) {
    throw new Error('Review request and configuration versions do not match.');
  }

  const now = options.clock?.() ?? new Date();
  const runId = options.runIdFactory?.() ?? randomUUID();
  if (runId.trim().length === 0) {
    throw new Error('Review run id must not be empty.');
  }
  if (Number.isNaN(now.getTime())) {
    throw new Error('Review start time must be valid.');
  }

  return {
    runId,
    request,
    config,
    status: 'queued',
    verdict: null,
    findings: [],
    startedAt: now.toISOString(),
    completedAt: null,
  };
}

export function buildReviewBudget(
  request: ReviewRequest,
  config: RepositoryConfig,
  nowMs = Date.now(),
): LocalReviewBudget {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('Review budget start time must be a nonnegative integer.');
  }
  const deadlineMs = nowMs + request.runBudget.maxDurationMs;
  if (!Number.isSafeInteger(deadlineMs)) {
    throw new Error('Review budget deadline exceeds the safe integer range.');
  }

  return {
    maxDurationMs: request.runBudget.maxDurationMs,
    maxModelTokens: Math.min(
      request.runBudget.maxModelTokens,
      config.tokenBudget,
    ),
    maxProofAttempts: request.runBudget.maxProofAttempts,
    deadlineMs,
  };
}
