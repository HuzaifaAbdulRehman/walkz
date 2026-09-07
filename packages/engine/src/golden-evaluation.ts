import {
  parseGoldenProofRecords,
  type GoldenProofRecord,
} from '@walkz/contracts';

export interface GoldenProofMetrics {
  caseCount: number;
  regressionCount: number;
  cleanCount: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  verifiedProofCount: number;
  incompleteCount: number;
  catchRate: number | null;
  falsePositiveRate: number | null;
  proofRate: number;
  incompleteRate: number;
  totalProofDurationMs: number;
  averageProofDurationMs: number;
  modelInvocationCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalModelLatencyMs: number;
}

export interface GoldenProofEvaluation {
  records: GoldenProofRecord[];
  metrics: GoldenProofMetrics;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function evaluateGoldenProofs(input: unknown): GoldenProofEvaluation {
  const records = parseGoldenProofRecords(input);
  let regressionCount = 0;
  let cleanCount = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let verifiedProofCount = 0;
  let incompleteCount = 0;
  let totalProofDurationMs = 0;
  let modelInvocationCount = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalModelLatencyMs = 0;

  for (const record of records) {
    const expectedRegression = record.expected === 'verified';
    const verified = record.classification === 'verified';
    regressionCount += expectedRegression ? 1 : 0;
    cleanCount += expectedRegression ? 0 : 1;
    truePositives += expectedRegression && verified ? 1 : 0;
    falsePositives += !expectedRegression && verified ? 1 : 0;
    falseNegatives += expectedRegression && !verified ? 1 : 0;
    verifiedProofCount += verified ? 1 : 0;
    incompleteCount +=
      record.classification === 'incomplete' || record.classification === 'invalid'
        ? 1
        : 0;
    totalProofDurationMs += record.proofDurationMs;
    if (record.usage !== null) {
      modelInvocationCount += 1;
      totalPromptTokens += record.usage.promptTokens;
      totalCompletionTokens += record.usage.completionTokens;
      totalModelLatencyMs += record.usage.latencyMs;
    }
  }

  return {
    records,
    metrics: {
      caseCount: records.length,
      regressionCount,
      cleanCount,
      truePositives,
      falsePositives,
      falseNegatives,
      verifiedProofCount,
      incompleteCount,
      catchRate: rate(truePositives, regressionCount),
      falsePositiveRate: rate(falsePositives, cleanCount),
      proofRate: verifiedProofCount / records.length,
      incompleteRate: incompleteCount / records.length,
      totalProofDurationMs,
      averageProofDurationMs: totalProofDurationMs / records.length,
      modelInvocationCount,
      totalPromptTokens,
      totalCompletionTokens,
      totalModelLatencyMs,
    },
  };
}
