import { describe, expect, it } from 'vitest';

import { parsePatchReproofResult } from '../src/index.js';

const proof = {
  kind: 'proof' as const,
  planDigest: 'a'.repeat(64),
  commandDigest: 'b'.repeat(64),
  outcome: 'passed' as const,
  exitCode: 0,
  durationMs: 10,
  sanitizedSummary: 'proof passed',
  artifacts: [],
};

const result = {
  schemaVersion: 1 as const,
  proposalId: '34e04c9f-bf3a-4ab9-9c81-902ad75d0110',
  reviewRunId: 'f931b8c5-f267-4b1b-8cb4-273695d4448e',
  findingId: '15d3e79e-02eb-42c3-91c5-0e48c4b5bf68',
  attempt: 1,
  patchHash: 'c'.repeat(64),
  headSha: 'd'.repeat(40),
  outcome: 'resolved' as const,
  proof,
  regressions: [],
  recordedAt: '2026-09-11T00:00:00.000Z',
};

describe('patch reproof result contract', () => {
  it('accepts hash-only evidence without patch source', () => {
    expect(parsePatchReproofResult(result)).toEqual(result);
  });

  it('derives resolution strictly from every required check', () => {
    expect(() => parsePatchReproofResult({
      ...result,
      outcome: 'resolved',
      regressions: [{
        ...proof,
        kind: 'regression',
        outcome: 'failed',
        exitCode: 1,
      }],
    })).toThrow('does not match');
    expect(parsePatchReproofResult({
      ...result,
      outcome: 'inconclusive',
      proof: { ...proof, outcome: 'timed_out', exitCode: null },
    })).toMatchObject({ outcome: 'inconclusive' });
    expect(parsePatchReproofResult({
      ...result,
      outcome: 'unresolved',
      regressions: [
        { ...proof, kind: 'regression', outcome: 'failed', exitCode: 1 },
        { ...proof, kind: 'regression', outcome: 'timed_out', exitCode: null },
      ],
    })).toMatchObject({ outcome: 'unresolved' });
  });

  it('rejects exit codes that contradict check outcomes', () => {
    expect(() => parsePatchReproofResult({
      ...result,
      proof: { ...proof, exitCode: 1 },
    })).toThrow('code zero');
    expect(() => parsePatchReproofResult({
      ...result,
      outcome: 'unresolved',
      proof: { ...proof, outcome: 'failed', exitCode: 0 },
    })).toThrow('nonzero');
  });

  it('rejects patch text and mislabeled checks', () => {
    expect(() => parsePatchReproofResult({
      ...result,
      replacement: 'private source',
    })).toThrow();
    expect(() => parsePatchReproofResult({
      ...result,
      proof: { ...proof, kind: 'regression' },
    })).toThrow('primary');
  });
});
