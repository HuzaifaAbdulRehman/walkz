import { describe, expect, it } from 'vitest';

import { evaluateGoldenProofs } from '../src/index.js';

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
