import { describe, expect, it } from 'vitest';

import {
  parseGoldenProofBaseline,
  parseGoldenProofFixtureManifest,
  parseGoldenProofRecords,
} from '../src/index.js';

function record() {
  return {
    id: 'broken-boundary',
    fixture: 'broken',
    language: 'javascript-typescript',
    expected: 'verified',
    classification: 'verified',
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    proofDurationMs: 42,
    provider: null,
    model: null,
    promptVersion: null,
    usage: null,
  };
}

describe('parseGoldenProofRecords', () => {
  it('normalizes a proof-only evaluation record', () => {
    expect(parseGoldenProofRecords([record()])).toEqual([record()]);
  });

  it('requires complete provider metadata when a provider is recorded', () => {
    expect(() =>
      parseGoldenProofRecords([
        { ...record(), provider: 'mock', model: 'mock/reviewer' },
      ]),
    ).toThrow(/recorded together/i);
  });

  it('rejects duplicate case IDs and identical revisions', () => {
    expect(() =>
      parseGoldenProofRecords([
        record(),
        { ...record(), baseSha: '2'.repeat(40) },
      ]),
    ).toThrow(/differ|unique/i);
  });

  it('requires an explicit, unique fixture expectation and reproducer', () => {
    expect(
      parseGoldenProofFixtureManifest({
        schemaVersion: 2,
        cases: [
          {
            id: 'broken-boundary',
            fixture: 'broken',
            language: 'javascript-typescript',
            expected: 'verified',
            finding: {
              category: 'correctness',
              severity: 'high',
              file: 'src/value.mjs',
              line: 1,
              claim: 'The boundary is wrong.',
              failureMechanism: 'Zero crosses the boundary.',
              suggestedProof: 'Run the boundary case.',
              confidence: 0.9,
            },
            reproducerSource: 'process.exit(0);\n',
          },
        ],
      }),
    ).toMatchObject({ cases: [{ id: 'broken-boundary' }] });
  });
});

describe('parseGoldenProofBaseline', () => {
  const baseline = {
    schemaVersion: 2,
    suiteId: 'counterfactual-proof-v1',
    behaviorFingerprint: 'A'.repeat(64),
    cases: [
      {
        id: 'broken-boundary',
        language: 'javascript-typescript',
        expected: 'verified',
        classification: 'verified',
      },
    ],
    thresholds: { maxCaseRegressions: 0 },
  };

  it('normalizes a versioned baseline', () => {
    expect(parseGoldenProofBaseline(baseline)).toMatchObject({
      behaviorFingerprint: 'a'.repeat(64),
      cases: [{ id: 'broken-boundary' }],
    });
  });

  it('rejects duplicate case IDs', () => {
    expect(() =>
      parseGoldenProofBaseline({
        ...baseline,
        cases: [baseline.cases[0], baseline.cases[0]],
      }),
    ).toThrow(/unique/i);
  });
});
