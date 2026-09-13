import { createHash } from 'node:crypto';

import {
  parseReviewEvaluationSnapshot,
  type ReviewEvaluationSnapshot,
} from '@walkz/contracts';

export interface ReviewEvaluationMetrics {
  runCount: number;
  findingCount: number;
  verifiedFindings: number;
  supportedFindings: number;
  unverifiedFindings: number;
  dismissedFindings: number;
  fixedFindings: number;
  labeledFindings: number;
  correctFindings: number;
  falsePositiveFindings: number;
  falsePositiveRate: number | null;
  proofAttemptedFindings: number;
  proofVerifiedFindings: number;
  proofIncompleteFindings: number;
  proofRate: number | null;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalModelLatencyMs: number;
  averageModelLatencyMs: number;
}

export interface ReviewEvaluationCandidate {
  configHash: string;
  provider: string;
  model: string;
  promptVersion: string;
  metrics: ReviewEvaluationMetrics;
}

export interface ReviewEvaluation {
  schemaVersion: 1;
  cohortId: string;
  cohortHash: string;
  createdAt: string;
  candidates: ReviewEvaluationCandidate[];
}

function canonicalSnapshot(snapshot: ReviewEvaluationSnapshot): string {
  const runs = snapshot.runs
    .map((run) => ({
      ...run,
      findings: [...run.findings].sort((left, right) =>
        left.findingId.localeCompare(right.findingId)),
    }))
    .sort((left, right) => left.reviewRunId.localeCompare(right.reviewRunId));
  return JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    cohortId: snapshot.cohortId,
    runs,
  });
}

function emptyMetrics(): ReviewEvaluationMetrics {
  return {
    runCount: 0,
    findingCount: 0,
    verifiedFindings: 0,
    supportedFindings: 0,
    unverifiedFindings: 0,
    dismissedFindings: 0,
    fixedFindings: 0,
    labeledFindings: 0,
    correctFindings: 0,
    falsePositiveFindings: 0,
    falsePositiveRate: null,
    proofAttemptedFindings: 0,
    proofVerifiedFindings: 0,
    proofIncompleteFindings: 0,
    proofRate: null,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalModelLatencyMs: 0,
    averageModelLatencyMs: 0,
  };
}

function finishMetrics(metrics: ReviewEvaluationMetrics): ReviewEvaluationMetrics {
  return {
    ...metrics,
    falsePositiveRate: metrics.labeledFindings === 0
      ? null
      : metrics.falsePositiveFindings / metrics.labeledFindings,
    proofRate: metrics.proofAttemptedFindings === 0
      ? null
      : metrics.proofVerifiedFindings / metrics.proofAttemptedFindings,
    averageModelLatencyMs: metrics.runCount === 0
      ? 0
      : metrics.totalModelLatencyMs / metrics.runCount,
  };
}

export function evaluateReviewSnapshot(input: unknown): ReviewEvaluation {
  const snapshot = parseReviewEvaluationSnapshot(input);
  const groups = new Map<string, ReviewEvaluationCandidate>();

  for (const run of snapshot.runs) {
    const key = JSON.stringify([
      run.configHash,
      run.provider,
      run.model,
      run.promptVersion,
    ]);
    const candidate = groups.get(key) ?? {
      configHash: run.configHash,
      provider: run.provider,
      model: run.model,
      promptVersion: run.promptVersion,
      metrics: emptyMetrics(),
    };
    const metrics = candidate.metrics;
    metrics.runCount += 1;
    metrics.totalPromptTokens += run.usage.promptTokens;
    metrics.totalCompletionTokens += run.usage.completionTokens;
    metrics.totalTokens += run.usage.totalTokens;
    metrics.totalModelLatencyMs += run.usage.latencyMs;

    for (const finding of run.findings) {
      metrics.findingCount += 1;
      metrics.verifiedFindings += finding.evidenceLevel === 'VERIFIED' ? 1 : 0;
      metrics.supportedFindings += finding.evidenceLevel === 'SUPPORTED' ? 1 : 0;
      metrics.unverifiedFindings += finding.evidenceLevel === 'UNVERIFIED' ? 1 : 0;
      metrics.dismissedFindings += finding.lifecycleStatus === 'dismissed' ? 1 : 0;
      metrics.fixedFindings += finding.lifecycleStatus === 'fixed' ? 1 : 0;
      metrics.labeledFindings += finding.feedback === null ? 0 : 1;
      metrics.correctFindings += finding.feedback === 'correct' ? 1 : 0;
      metrics.falsePositiveFindings += finding.feedback === 'false_positive' ? 1 : 0;
      metrics.proofAttemptedFindings += finding.proofOutcome === 'not_requested' ? 0 : 1;
      metrics.proofVerifiedFindings += finding.proofOutcome === 'verified' ? 1 : 0;
      metrics.proofIncompleteFindings += finding.proofOutcome === 'incomplete' ? 1 : 0;
    }
    groups.set(key, candidate);
  }

  return {
    schemaVersion: 1,
    cohortId: snapshot.cohortId,
    cohortHash: createHash('sha256')
      .update(canonicalSnapshot(snapshot), 'utf8')
      .digest('hex'),
    createdAt: snapshot.createdAt,
    candidates: [...groups.values()]
      .map((candidate) => ({
        ...candidate,
        metrics: finishMetrics(candidate.metrics),
      }))
      .sort((left, right) =>
        JSON.stringify([
          left.configHash,
          left.provider,
          left.model,
          left.promptVersion,
        ])
          .localeCompare(JSON.stringify([
            right.configHash,
            right.provider,
            right.model,
            right.promptVersion,
          ]))),
  };
}
