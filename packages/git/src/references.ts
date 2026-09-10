import {
  GitCommandError,
  runGitText,
  type RunGitOptions,
} from './process.js';
import type { ResolvedGitReferences } from './types.js';
import { assertCommitSha } from './validation.js';

export interface ResolveGitReferencesOptions {
  baseRef?: string | null;
  githubToken?: string | undefined;
  staged?: boolean;
  signal?: AbortSignal | undefined;
}

type ReferenceGitOptions = Pick<RunGitOptions, 'githubToken' | 'signal'>;

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
  options: ReferenceGitOptions = {},
): Promise<string> {
  validateReference(reference);
  const output = (
    await runGitText(
      repositoryRoot,
      ['rev-parse', '--verify', '--end-of-options', reference + '^{commit}'],
      options,
    )
  ).trim();
  assertCommitSha(output);
  return output;
}

async function tryResolveCommit(
  repositoryRoot: string,
  reference: string,
  options: ReferenceGitOptions = {},
): Promise<string | null> {
  try {
    return await resolveCommit(repositoryRoot, reference, options);
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode !== null) {
      return null;
    }
    throw error;
  }
}

async function defaultBaseReference(
  repositoryRoot: string,
  options: ReferenceGitOptions = {},
): Promise<{ reference: string; sha: string }> {
  try {
    const symbolic = (
      await runGitText(
        repositoryRoot,
        ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
        options,
      )
    ).trim();
    if (symbolic.length > 0) {
      const sha = await tryResolveCommit(repositoryRoot, symbolic, options);
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
    const sha = await tryResolveCommit(repositoryRoot, reference, options);
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
  const gitOptions = {
    githubToken: options.githubToken,
    signal: options.signal,
  };
  const headSha = await resolveCommit(repositoryRoot, 'HEAD', gitOptions);
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
      ? await defaultBaseReference(repositoryRoot, gitOptions)
      : {
          reference: options.baseRef,
          sha: await resolveCommit(
            repositoryRoot,
            options.baseRef,
            gitOptions,
          ),
        };
  const mergeBase = (
    await runGitText(
      repositoryRoot,
      ['merge-base', selectedBase.sha, headSha],
      gitOptions,
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
