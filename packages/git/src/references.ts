import { GitCommandError, runGitText } from './process.js';
import type { ResolvedGitReferences } from './types.js';
import { assertCommitSha } from './validation.js';

export interface ResolveGitReferencesOptions {
  baseRef?: string | null;
  staged?: boolean;
  signal?: AbortSignal | undefined;
}

function validateReference(reference: string): void {
  if (
    reference.length === 0 ||
    reference.length > 512 ||
    reference.includes('\0')
  ) {
    throw new GitCommandError('Git reference is invalid.');
  }
}

async function resolveCommit(
  repositoryRoot: string,
  reference: string,
  signal?: AbortSignal,
): Promise<string> {
  validateReference(reference);
  const output = (
    await runGitText(
      repositoryRoot,
      ['rev-parse', '--verify', '--end-of-options', reference + '^{commit}'],
      { signal },
    )
  ).trim();
  assertCommitSha(output);
  return output;
}

async function tryResolveCommit(
  repositoryRoot: string,
  reference: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    return await resolveCommit(repositoryRoot, reference, signal);
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode !== null) {
      return null;
    }
    throw error;
  }
}

async function defaultBaseReference(
  repositoryRoot: string,
  signal?: AbortSignal,
): Promise<{ reference: string; sha: string }> {
  try {
    const symbolic = (
      await runGitText(
        repositoryRoot,
        ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
        { signal },
      )
    ).trim();
    if (symbolic.length > 0) {
      const sha = await tryResolveCommit(repositoryRoot, symbolic, signal);
      if (sha !== null) {
        return { reference: symbolic, sha };
      }
    }
  } catch (error) {
    if (!(error instanceof GitCommandError && error.exitCode !== null)) {
      throw error;
    }
  }

  for (const reference of [
    'refs/remotes/origin/main',
    'refs/heads/main',
    'refs/remotes/origin/master',
    'refs/heads/master',
  ]) {
    const sha = await tryResolveCommit(repositoryRoot, reference, signal);
    if (sha !== null) {
      return { reference, sha };
    }
  }
  throw new GitCommandError(
    'No base branch was found. Set baseBranch in walkz.config.json.',
  );
}

export async function resolveGitReferences(
  repositoryRoot: string,
  options: ResolveGitReferencesOptions = {},
): Promise<ResolvedGitReferences> {
  const headSha = await resolveCommit(repositoryRoot, 'HEAD', options.signal);
  if (options.staged === true) {
    return {
      mode: 'staged',
      baseRef: 'HEAD',
      baseTipSha: headSha,
      baseSha: headSha,
      headRef: 'INDEX',
      headSha: null,
      guidanceSha: headSha,
    };
  }

  const selectedBase =
    options.baseRef === undefined || options.baseRef === null
      ? await defaultBaseReference(repositoryRoot, options.signal)
      : {
          reference: options.baseRef,
          sha: await resolveCommit(
            repositoryRoot,
            options.baseRef,
            options.signal,
          ),
        };
  const mergeBase = (
    await runGitText(
      repositoryRoot,
      ['merge-base', selectedBase.sha, headSha],
      { signal: options.signal },
    )
  ).trim();
  assertCommitSha(mergeBase);

  return {
    mode: 'branch',
    baseRef: selectedBase.reference,
    baseTipSha: selectedBase.sha,
    baseSha: mergeBase,
    headRef: 'HEAD',
    headSha,
    guidanceSha: mergeBase,
  };
}
