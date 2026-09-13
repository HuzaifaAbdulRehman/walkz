import {
  parseGoldenProofBaseline,
  parseGoldenProofRecords,
  type GoldenProofBaseline,
  type GoldenProofClassification,
  type GoldenProofExpectation,
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

export interface GoldenProofCaseRegression {
  id: string;
  kind: 'missing' | 'unexpected' | 'changed';
  baselineExpected: GoldenProofExpectation | null;
  baselineClassification: GoldenProofClassification | null;
  currentExpected: GoldenProofExpectation | null;
  currentClassification: GoldenProofClassification | null;
}

export interface GoldenProofBaselineComparison {
  baselineFingerprint: string;
  caseRegressions: GoldenProofCaseRegression[];
  threshold: number;
  passed: boolean;
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

export function compareGoldenProofBaseline(
  input: unknown,
  evaluation: GoldenProofEvaluation,
): GoldenProofBaselineComparison {
  const baseline: GoldenProofBaseline = parseGoldenProofBaseline(input);
  const currentById = new Map(
    evaluation.records.map((record) => [record.id, record]),
  );
  const baselineIds = new Set(baseline.cases.map((record) => record.id));
  const caseRegressions: GoldenProofCaseRegression[] = [];

  for (const expected of baseline.cases) {
    const current = currentById.get(expected.id);
    if (current === undefined) {
      caseRegressions.push({
        id: expected.id,
        kind: 'missing',
        baselineExpected: expected.expected,
        baselineClassification: expected.classification,
        currentExpected: null,
        currentClassification: null,
      });
      continue;
    }
    if (
      current.expected !== expected.expected ||
      current.classification !== expected.classification
    ) {
      caseRegressions.push({
        id: expected.id,
        kind: 'changed',
        baselineExpected: expected.expected,
        baselineClassification: expected.classification,
        currentExpected: current.expected,
        currentClassification: current.classification,
      });
    }
  }

  for (const current of evaluation.records) {
    if (!baselineIds.has(current.id)) {
      caseRegressions.push({
        id: current.id,
        kind: 'unexpected',
        baselineExpected: null,
        baselineClassification: null,
        currentExpected: current.expected,
        currentClassification: current.classification,
      });
    }
  }

  const threshold = baseline.thresholds.maxCaseRegressions;
  return {
    baselineFingerprint: baseline.behaviorFingerprint,
    caseRegressions,
    threshold,
    passed: caseRegressions.length <= threshold,
  };
}
