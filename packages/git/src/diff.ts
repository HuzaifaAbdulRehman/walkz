import { parsePatch } from 'diff';

import { comparisonArguments } from './comparison.js';
import { GitCommandError, GitOutputLimitError, runGitText } from './process.js';
import type {
  ChangedFile,
  CoverageOmission,
  DiffLineIndex,
  ResolvedGitReferences,
  UnifiedDiffCollection,
} from './types.js';
import { assertRepositoryPath } from './validation.js';

export interface CollectUnifiedDiffOptions {
  githubToken?: string | undefined;
  maxBytes: number;
  signal?: AbortSignal | undefined;
}

function omissionForNonTextFile(file: ChangedFile): CoverageOmission | null {
  if (file.kind === 'text') {
    return null;
  }
  return { path: file.path, reason: file.kind };
}

export async function collectUnifiedDiff(
  repositoryRoot: string,
  references: ResolvedGitReferences,
  files: readonly ChangedFile[],
  options: CollectUnifiedDiffOptions,
): Promise<UnifiedDiffCollection> {
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error('Diff budget must be a positive integer.');
  }
  const parts: string[] = [];
  const includedPaths: string[] = [];
  const omissions: CoverageOmission[] = [];
  let bytes = 0;

  for (const file of files) {
    const nonTextOmission = omissionForNonTextFile(file);
    if (nonTextOmission !== null) {
      omissions.push(nonTextOmission);
      continue;
    }
    const remainingBytes = options.maxBytes - bytes;
    if (remainingBytes < 1) {
      omissions.push({ path: file.path, reason: 'diff_budget' });
      continue;
    }
    try {
      assertRepositoryPath(file.path);
      if (file.oldPath !== undefined) {
        assertRepositoryPath(file.oldPath);
      }
      const pathspecs =
        file.oldPath === undefined
          ? [file.path]
          : [file.oldPath, file.path];
      const patch = await runGitText(
        repositoryRoot,
        [
          '--literal-pathspecs',
          'diff',
          '--find-renames',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--unified=3',
          ...comparisonArguments(references),
          '--',
          ...pathspecs,
        ],
        {
          githubToken: options.githubToken,
          maxOutputBytes: remainingBytes,
          signal: options.signal,
        },
      );
      const patchBytes = Buffer.byteLength(patch);
      if (patchBytes === 0) {
        throw new GitCommandError('Git omitted a patch for a changed file.');
      }
      parts.push(patch);
      includedPaths.push(file.path);
      bytes += patchBytes;
    } catch (error) {
      if (error instanceof GitOutputLimitError) {
        omissions.push({ path: file.path, reason: 'diff_budget' });
        continue;
      }
      throw error;
    }
  }

  return {
    text: parts.join(''),
    bytes,
    includedPaths,
    omissions,
  };
}

function normalizePatchPath(path: string | undefined): string | null {
  if (path === undefined || path === '/dev/null') {
    return null;
  }
  const normalized = path.startsWith('b/') ? path.slice(2) : path;
  assertRepositoryPath(normalized);
  return normalized;
}

export function buildDiffLineIndex(diff: string): DiffLineIndex {
  if (diff.includes('\0')) {
    throw new GitCommandError('Patch text cannot contain NUL bytes.');
  }
  let patches;
  try {
    patches = parsePatch(diff);
  } catch {
    throw new GitCommandError('Git returned a malformed unified diff.');
  }
  const index = new Map<string, ReadonlySet<number>>();

  for (const patch of patches) {
    const path = normalizePatchPath(patch.newFileName);
    if (path === null) {
      continue;
    }
    const lines = new Set<number>();
    for (const hunk of patch.hunks) {
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      let oldCount = 0;
      let newCount = 0;
      for (const line of hunk.lines) {
        const marker = line[0];
        if (marker === '+') {
          lines.add(newLine);
          newLine += 1;
          newCount += 1;
        } else if (marker === '-') {
          oldLine += 1;
          oldCount += 1;
        } else if (marker === ' ') {
          oldLine += 1;
          newLine += 1;
          oldCount += 1;
          newCount += 1;
        } else if (marker !== '\\') {
          throw new GitCommandError('Patch contained an invalid hunk line.');
        }
      }
      if (oldCount !== hunk.oldLines || newCount !== hunk.newLines) {
        throw new GitCommandError('Patch hunk line counts did not match its header.');
      }
    }
    index.set(path, lines);
  }
  return index;
}
