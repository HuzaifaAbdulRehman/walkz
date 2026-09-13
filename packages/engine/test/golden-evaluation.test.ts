import { describe, expect, it } from 'vitest';

import {
  compareGoldenProofBaseline,
  evaluateGoldenProofs,
} from '../src/index.js';

function record(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'broken-boundary',
    fixture: 'broken',
    expected: 'verified',
    classification: 'verified',
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    proofDurationMs: 24,
    provider: null,
    model: null,
    promptVersion: null,
    usage: null,
    ...overrides,
  };
}

describe('evaluateGoldenProofs', () => {
  it('measures a verified regression and a clean change separately', () => {
    const evaluation = evaluateGoldenProofs([
      record(),
      record({
        id: 'clean-value',
        fixture: 'clean',
        expected: 'not_verified',
        classification: 'not_verified',
        baseSha: '3'.repeat(40),
        headSha: '4'.repeat(40),
        proofDurationMs: 12,
      }),
    ]);

    expect(evaluation.metrics).toEqual({
      caseCount: 2,
      regressionCount: 1,
      cleanCount: 1,
      truePositives: 1,
      falsePositives: 0,
      falseNegatives: 0,
      verifiedProofCount: 1,
      incompleteCount: 0,
      catchRate: 1,
      falsePositiveRate: 0,
      proofRate: 0.5,
      incompleteRate: 0,
      totalProofDurationMs: 36,
      averageProofDurationMs: 18,
      modelInvocationCount: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalModelLatencyMs: 0,
    });
  });

  it('counts missed and incomplete regressions without calling them catches', () => {
    const evaluation = evaluateGoldenProofs([
      record({ classification: 'not_verified' }),
      record({
        id: 'timeout-boundary',
        classification: 'incomplete',
        baseSha: '3'.repeat(40),
        headSha: '4'.repeat(40),
      }),
    ]);

    expect(evaluation.metrics).toMatchObject({
      truePositives: 0,
      falseNegatives: 2,
      incompleteCount: 1,
      catchRate: 0,
      proofRate: 0,
      incompleteRate: 0.5,
    });
  });

  it('aggregates provider usage only when a provider was invoked', () => {
    const evaluation = evaluateGoldenProofs([
      record({
        provider: 'mock',
        model: 'mock/reviewer',
        promptVersion: 'review-v1',
        usage: {
          promptTokens: 12,
          completionTokens: 3,
          totalTokens: 15,
          latencyMs: 9,
        },
      }),
    ]);

    expect(evaluation.metrics).toMatchObject({
      modelInvocationCount: 1,
      totalPromptTokens: 12,
      totalCompletionTokens: 3,
      totalModelLatencyMs: 9,
    });
  });
});

describe('compareGoldenProofBaseline', () => {
  function baseline() {
    return {
      schemaVersion: 1,
      suiteId: 'counterfactual-proof-v1',
      behaviorFingerprint: 'a'.repeat(64),
      cases: [
        {
          id: 'broken-boundary',
          expected: 'verified',
          classification: 'verified',
        },
      ],
      thresholds: { maxCaseRegressions: 0 },
    };
  }

  it('passes when every deterministic case matches', () => {
    const comparison = compareGoldenProofBaseline(
      baseline(),
      evaluateGoldenProofs([record()]),
    );

    expect(comparison).toEqual({
      baselineFingerprint: 'a'.repeat(64),
      caseRegressions: [],
      threshold: 0,
      passed: true,
    });
  });

  it('fails when a classification changes', () => {
    const comparison = compareGoldenProofBaseline(
      baseline(),
      evaluateGoldenProofs([record({ classification: 'not_verified' })]),
    );

    expect(comparison).toMatchObject({
      caseRegressions: [
        {
          id: 'broken-boundary',
          kind: 'changed',
          baselineClassification: 'verified',
          currentClassification: 'not_verified',
        },
      ],
      passed: false,
    });
  });

  it('reports missing and unexpected cases', () => {
    const comparison = compareGoldenProofBaseline(
      baseline(),
      evaluateGoldenProofs([
        record({
          id: 'new-case',
          baseSha: '3'.repeat(40),
          headSha: '4'.repeat(40),
        }),
      ]),
    );

    expect(comparison.caseRegressions).toEqual([
      expect.objectContaining({ id: 'broken-boundary', kind: 'missing' }),
      expect.objectContaining({ id: 'new-case', kind: 'unexpected' }),
    ]);
    expect(comparison.passed).toBe(false);
  });
});
