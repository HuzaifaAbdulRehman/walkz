import { describe, expect, it } from 'vitest';

import { evaluateReviewSnapshot } from '../src/index.js';

const run = {
  reviewRunId: '11111111-1111-4111-8111-111111111111',
  configHash: 'a'.repeat(64),
  provider: 'groq',
  model: 'model-a',
  promptVersion: 'prompt-v1',
  usage: {
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    latencyMs: 500,
  },
  findings: [
    {
      findingId: '22222222-2222-4222-8222-222222222222',
      evidenceLevel: 'VERIFIED',
      lifecycleStatus: 'fixed',
      proofOutcome: 'verified',
      feedback: 'correct',
    },
    {
      findingId: '33333333-3333-4333-8333-333333333333',
      evidenceLevel: 'UNVERIFIED',
      lifecycleStatus: 'dismissed',
      proofOutcome: 'incomplete',
      feedback: 'false_positive',
    },
  ],
};

describe('evaluateReviewSnapshot', () => {
  it('groups exact model and prompt candidates without overstating recall', () => {
    const evaluation = evaluateReviewSnapshot({
      schemaVersion: 1,
      cohortId: 'september-reviews',
      createdAt: '2026-09-13T12:00:00.000Z',
      runs: [
        run,
        {
          ...run,
          reviewRunId: '44444444-4444-4444-8444-444444444444',
          usage: {
            promptTokens: 50,
            completionTokens: 10,
            totalTokens: 60,
            latencyMs: 300,
          },
          findings: [],
        },
        {
          ...run,
          reviewRunId: '55555555-5555-4555-8555-555555555555',
          model: 'model-b',
          findings: [],
        },
        {
          ...run,
          reviewRunId: '66666666-6666-4666-8666-666666666666',
          configHash: 'b'.repeat(64),
          findings: [],
        },
      ],
    });

    expect(evaluation.cohortHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evaluation.candidates).toHaveLength(3);
    expect(evaluation.candidates[0]).toMatchObject({
      configHash: 'a'.repeat(64),
      provider: 'groq',
      model: 'model-a',
      promptVersion: 'prompt-v1',
      metrics: {
        runCount: 2,
        findingCount: 2,
        verifiedFindings: 1,
        unverifiedFindings: 1,
        dismissedFindings: 1,
        fixedFindings: 1,
        labeledFindings: 2,
        falsePositiveFindings: 1,
        falsePositiveRate: 0.5,
        proofAttemptedFindings: 2,
        proofVerifiedFindings: 1,
        proofIncompleteFindings: 1,
        proofRate: 0.5,
        totalTokens: 180,
        totalModelLatencyMs: 800,
        averageModelLatencyMs: 400,
      },
    });
    expect(evaluation.candidates[0]?.metrics).not.toHaveProperty('recall');
  });

  it('hashes the same cohort independently of export time and record order', () => {
    const snapshot = {
      schemaVersion: 1 as const,
      cohortId: 'stable-cohort',
      createdAt: '2026-09-13T12:00:00.000Z',
      runs: [
        run,
        {
          ...run,
          reviewRunId: '44444444-4444-4444-8444-444444444444',
          findings: [],
        },
      ],
    };

    const forward = evaluateReviewSnapshot(snapshot);
    const reversed = evaluateReviewSnapshot({
      ...snapshot,
      createdAt: '2026-09-14T12:00:00.000Z',
      runs: [snapshot.runs[1], {
        ...snapshot.runs[0],
        findings: [...snapshot.runs[0]!.findings].reverse(),
      }],
    });

    expect(reversed.cohortHash).toBe(forward.cohortHash);
  });

  it('rejects duplicate review and finding identities', () => {
    expect(() => evaluateReviewSnapshot({
      schemaVersion: 1,
      cohortId: 'duplicate-runs',
      createdAt: '2026-09-13T12:00:00.000Z',
      runs: [run, run],
    })).toThrow(/run IDs must be unique/i);
    expect(() => evaluateReviewSnapshot({
      schemaVersion: 1,
      cohortId: 'duplicate-findings',
      createdAt: '2026-09-13T12:00:00.000Z',
      runs: [{ ...run, findings: [run.findings[0], run.findings[0]] }],
    })).toThrow(/finding IDs must be unique/i);
    expect(() => evaluateReviewSnapshot({
      schemaVersion: 1,
      cohortId: 'invalid-proof',
      createdAt: '2026-09-13T12:00:00.000Z',
      runs: [{
        ...run,
        findings: [{
          ...run.findings[1],
          proofOutcome: 'verified',
        }],
      }],
    })).toThrow(/verified evidence/i);
    expect(() => evaluateReviewSnapshot({
      schemaVersion: 1,
      cohortId: 'private-content',
      createdAt: '2026-09-13T12:00:00.000Z',
      runs: [{
        ...run,
        rawPrompt: 'private source code',
        rawResponse: 'private model output',
      }],
    })).toThrow(/unrecognized key/i);
  });
});
