import type { ResolvedGitReferences } from './types.js';
import { assertCommitSha } from './validation.js';

export function comparisonArguments(
  references: ResolvedGitReferences,
): string[] {
  assertCommitSha(references.baseSha);
  if (references.mode === 'staged') {
    return ['--cached', references.baseSha];
  }
  if (references.headSha === null) {
    throw new Error('A branch comparison requires a head commit.');
  }
  assertCommitSha(references.headSha);
  return [references.baseSha, references.headSha];
}
