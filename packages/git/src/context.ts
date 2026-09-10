import { matchesGlob } from 'node:path';

import { collectChangedFiles } from './changes.js';
import { buildDiffLineIndex, collectUnifiedDiff } from './diff.js';
import { loadRepositoryGuidance } from './guidance.js';
import { calculateChangeRisk } from './risk.js';
import type {
  ChangedFile,
  CoverageOmission,
  ResolvedGitReferences,
  ReviewContext,
} from './types.js';

export interface CollectReviewContextOptions {
  fileBudget: number;
  diffBudgetBytes: number;
  githubToken?: string | undefined;
  guidanceBudgetBytes?: number;
  include?: readonly string[];
  exclude?: readonly string[];
  signal?: AbortSignal | undefined;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(name + ' must be a positive integer.');
  }
}

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/');
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

function isIncluded(
  file: ChangedFile,
  include: readonly string[],
  exclude: readonly string[],
): boolean {
  const path = normalizedPath(file.path);
  return matchesAny(path, include) && !matchesAny(path, exclude);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function collectReviewContext(
  repositoryRoot: string,
  references: ResolvedGitReferences,
  options: CollectReviewContextOptions,
): Promise<ReviewContext> {
  assertPositiveInteger(options.fileBudget, 'File budget');
  assertPositiveInteger(options.diffBudgetBytes, 'Diff budget');
  if (options.guidanceBudgetBytes !== undefined) {
    assertPositiveInteger(options.guidanceBudgetBytes, 'Guidance budget');
  }

  const include = options.include ?? ['**/*'];
  const exclude = options.exclude ?? [];
  const allFiles = await collectChangedFiles(
    repositoryRoot,
    references,
    {
      githubToken: options.githubToken,
      signal: options.signal,
    },
  );
  const omissions: CoverageOmission[] = [];
  const eligibleFiles = allFiles.filter((file) => {
    if (isIncluded(file, include, exclude)) {
      return true;
    }
    omissions.push({ path: file.path, reason: 'excluded' });
    return false;
  });
  const risks = Object.fromEntries(
    eligibleFiles.map((file) => [file.path, calculateChangeRisk(file)]),
  );
  const rankedFiles = [...eligibleFiles].sort((left, right) => {
    const scoreDifference = risks[right.path]!.score - risks[left.path]!.score;
    return scoreDifference === 0
      ? comparePaths(left.path, right.path)
      : scoreDifference;
  });
  const selectedFiles = rankedFiles.slice(0, options.fileBudget);
  for (const file of rankedFiles.slice(options.fileBudget)) {
    omissions.push({ path: file.path, reason: 'file_budget' });
  }

  const [diff, guidance] = await Promise.all([
    collectUnifiedDiff(repositoryRoot, references, selectedFiles, {
      githubToken: options.githubToken,
      maxBytes: options.diffBudgetBytes,
      signal: options.signal,
    }),
    loadRepositoryGuidance(repositoryRoot, references, {
      githubToken: options.githubToken,
      ...(options.guidanceBudgetBytes !== undefined && {
        maxBytes: options.guidanceBudgetBytes,
      }),
      signal: options.signal,
    }),
  ]);
  omissions.push(...diff.omissions);
  for (const omission of guidance.omissions) {
    omissions.push({
      path: omission.path,
      reason:
        omission.reason === 'budget'
          ? 'guidance_budget'
          : 'guidance_invalid',
    });
  }

  return {
    references,
    changedFiles: selectedFiles,
    risks,
    diff: diff.text,
    lineIndex: buildDiffLineIndex(diff.text),
    guidance,
    coverage: {
      complete: omissions.length === 0,
      changedFileCount: allFiles.length,
      selectedFileCount: diff.includedPaths.length,
      diffBytes: diff.bytes,
      omissions,
    },
  };
}
