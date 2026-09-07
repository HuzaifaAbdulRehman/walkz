import { describe, expect, it } from 'vitest';

import {
  parseGoldenProofFixtureManifest,
  parseGoldenProofRecords,
} from '../src/index.js';

function record() {
  return {
    id: 'broken-boundary',
    fixture: 'broken',
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
        schemaVersion: 1,
        cases: [
          {
            id: 'broken-boundary',
            fixture: 'broken',
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
