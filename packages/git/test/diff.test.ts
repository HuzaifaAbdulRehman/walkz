import { describe, expect, it } from 'vitest';

import {
  buildDiffLineIndex,
  collectUnifiedDiff,
  GitCommandError,
  type ChangedFile,
  type ResolvedGitReferences,
} from '../src/index.js';

const stagedReferences: ResolvedGitReferences = {
  mode: 'staged',
  baseRef: 'HEAD',
  baseTipSha: 'a'.repeat(40),
  baseSha: 'a'.repeat(40),
  headRef: 'INDEX',
  headSha: null,
  guidanceSha: 'a'.repeat(40),
};

function changedFile(path: string): ChangedFile {
  return {
    path,
    status: 'modified',
    statusCode: 'M',
    oldMode: '100644',
    newMode: '100644',
    additions: 1,
    deletions: 1,
    kind: 'text',
  };
}

describe('buildDiffLineIndex', () => {
  it('indexes only added lines across multiple hunks', () => {
    const patch = [
      'diff --git a/value.ts b/value.ts',
      'index 1111111..2222222 100644',
      '--- a/value.ts',
      '+++ b/value.ts',
      '@@ -1,2 +1,3 @@',
      ' first',
      '+added',
      ' second',
      '@@ -10,2 +11,2 @@',
      '-old',
      '+new',
      ' final',
      '',
    ].join('\n');

    expect(buildDiffLineIndex(patch).get('value.ts')).toEqual(
      new Set([2, 11]),
    );
  });

  it('decodes a quoted Unicode Git path', () => {
    const patch = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      'new file mode 100644',
      '--- /dev/null',
      '+++ "b/caf\\303\\251.ts"',
      '@@ -0,0 +1 @@',
      '+export {};',
      '',
    ].join('\n');

    expect(buildDiffLineIndex(patch).get('caf\u00e9.ts')).toEqual(new Set([1]));
  });

  it('rejects malformed hunk counts', () => {
    const patch = [
      '--- a/value.ts',
      '+++ b/value.ts',
      '@@ -1,1 +1,2 @@',
      '+only one line',
      '',
    ].join('\n');

    expect(() => buildDiffLineIndex(patch)).toThrow(GitCommandError);
  });

  it('rejects caller-created paths before invoking Git', async () => {
    await expect(
      collectUnifiedDiff('.', stagedReferences, [changedFile('../outside.ts')], {
        maxBytes: 1_024,
      }),
    ).rejects.toThrow('Repository path is unsafe.');
  });

  it('rejects caller-created commit identifiers before invoking Git', async () => {
    await expect(
      collectUnifiedDiff(
        '.',
        { ...stagedReferences, baseSha: '--output=/tmp/file' },
        [changedFile('value.ts')],
        { maxBytes: 1_024 },
      ),
    ).rejects.toThrow('Commit identifier is invalid.');
  });
});
