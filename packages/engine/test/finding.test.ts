import type { ModelFinding } from '@walkz/contracts';
import type { DiffLineIndex } from '@walkz/git';
import { describe, expect, it } from 'vitest';

import {
  fingerprintFinding,
  normalizeFinding,
  validateFindingLocation,
} from '../src/index.js';

function modelFinding(overrides: Partial<ModelFinding> = {}): ModelFinding {
  return {
    category: 'correctness',
    severity: 'high',
    file: './src\\math.ts',
    line: 7,
    endLine: 8,
    claim: '  Boundary   input returns zero.  ',
    failureMechanism: 'The new branch\n skips the fallback.',
    suggestedProof: 'Call it with the boundary input.',
    confidence: 0.91,
    ...overrides,
  };
}

describe('normalizeFinding', () => {
  it('normalizes model text and repository paths', () => {
    expect(normalizeFinding(modelFinding())).toMatchObject({
      file: 'src/math.ts',
      claim: 'Boundary input returns zero.',
      failureMechanism: 'The new branch skips the fallback.',
      lifecycleStatus: 'unverified',
      evidenceLevel: 'UNVERIFIED',
      advisoryConfidence: 0.91,
      evidence: [],
      dismissal: null,
      fix: null,
    });
  });

  it('removes invisible characters from prose', () => {
    expect(
      normalizeFinding(
        modelFinding({ claim: 'Wrong\u200B result\u202E returned.' }),
      ).claim,
    ).toBe('Wrong result returned.');
  });

  it('rejects invisible path characters and traversal', () => {
    expect(() =>
      normalizeFinding(modelFinding({ file: 'src/ma\u200Bth.ts' })),
    ).toThrow('invisible control');
    expect(() =>
      normalizeFinding(modelFinding({ file: '../outside.ts' })),
    ).toThrow();
    expect(() =>
      normalizeFinding(modelFinding({ file: 'src//math.ts' })),
    ).toThrow('inside the repository');
    expect(() =>
      normalizeFinding(modelFinding({ file: 'src/\nmath.ts' })),
    ).toThrow('invisible control');
  });

  it('revalidates runtime model data', () => {
    expect(() =>
      normalizeFinding({ ...modelFinding(), confidence: 4 }),
    ).toThrow();
  });
});

describe('fingerprintFinding', () => {
  it('is stable across display-only changes', () => {
    const first = normalizeFinding(modelFinding());
    const second = normalizeFinding(
      modelFinding({ severity: 'critical', confidence: 0.2 }),
    );

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintFinding(first)).toBe(first.fingerprint);
  });

  it('changes with the failure location or mechanism', () => {
    const original = normalizeFinding(modelFinding());
    expect(normalizeFinding(modelFinding({ line: 9, endLine: 9 })).fingerprint)
      .not.toBe(original.fingerprint);
    expect(
      normalizeFinding(
        modelFinding({ failureMechanism: 'A different branch fails.' }),
      ).fingerprint,
    ).not.toBe(original.fingerprint);
  });
});

describe('validateFindingLocation', () => {
  const lineIndex: DiffLineIndex = new Map([
    ['src/math.ts', new Set([7, 8, 10])],
  ]);

  it('accepts a range made only of changed lines', () => {
    expect(
      validateFindingLocation(normalizeFinding(modelFinding()), lineIndex),
    ).toEqual({ valid: true });
  });

  it.each([
    ['missing.ts', 7, undefined, 'file_not_changed'],
    ['src/math.ts', 6, undefined, 'line_not_changed'],
    ['src/math.ts', 8, 10, 'range_not_changed'],
  ] as const)(
    'rejects an invented location in %s',
    (file, line, endLine, reason) => {
      expect(
        validateFindingLocation(
          { file, line, ...(endLine === undefined ? {} : { endLine }) },
          lineIndex,
        ),
      ).toEqual({ valid: false, reason });
    },
  );

  it('rejects huge ranges in bounded work', () => {
    expect(
      validateFindingLocation(
        { file: 'src/math.ts', line: 7, endLine: Number.MAX_SAFE_INTEGER },
        lineIndex,
      ),
    ).toEqual({ valid: false, reason: 'range_not_changed' });
  });
});
