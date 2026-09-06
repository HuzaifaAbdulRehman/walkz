import { describe, expect, it } from 'vitest';

import { calculateChangeRisk, type ChangedFile } from '../src/index.js';

function changedFile(overrides: Partial<ChangedFile>): ChangedFile {
  return {
    path: 'src/value.ts',
    status: 'modified',
    statusCode: 'M',
    oldMode: '100644',
    newMode: '100644',
    additions: 2,
    deletions: 1,
    kind: 'text',
    ...overrides,
  };
}

describe('calculateChangeRisk', () => {
  it('prioritizes dependency and workflow changes', () => {
    const ordinary = calculateChangeRisk(changedFile({}));
    const lockfile = calculateChangeRisk(
      changedFile({ path: 'package-lock.json' }),
    );
    const workflow = calculateChangeRisk(
      changedFile({ path: '.github/workflows/release.yml' }),
    );

    expect(lockfile.score).toBeGreaterThan(ordinary.score);
    expect(workflow.score).toBeGreaterThan(ordinary.score);
  });

  it('raises risk when content cannot be reviewed as text', () => {
    const text = calculateChangeRisk(changedFile({ kind: 'text' }));
    const binary = calculateChangeRisk(
      changedFile({ additions: null, deletions: null, kind: 'binary' }),
    );

    expect(binary.score).toBeGreaterThan(text.score);
    expect(binary.reasons).toContain('content cannot be reviewed as text');
  });
});
