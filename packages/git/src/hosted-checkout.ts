import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import { z } from 'zod';

import { GitCommandError, runGitText, type RunGitOptions } from './process.js';

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const checkoutSchema = z.object({
  owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,99})$/),
  repository: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/)
    .refine((value) => value !== '.' && value !== '..'),
  baseSha: shaSchema,
  headSha: shaSchema,
  githubToken: z.string().trim().min(1).max(1_024),
}).strict().refine((value) => value.baseSha !== value.headSha, {
  message: 'Hosted checkout revisions must differ.',
  path: ['headSha'],
});

export interface HostedGitRunner {
  (
    repositoryRoot: string,
    args: readonly string[],
    options?: RunGitOptions,
  ): Promise<string>;
}

export interface HostedCheckoutOptions {
  runGit?: HostedGitRunner;
  signal?: AbortSignal;
  temporaryRoot?: string;
}

function assertTemporaryChild(parent: string, child: string): void {
  const pathFromParent = relative(parent, child);
  if (
    pathFromParent.length === 0 ||
    pathFromParent === '..' ||
    pathFromParent.startsWith('..\\') ||
    pathFromParent.startsWith('../') ||
    isAbsolute(pathFromParent)
  ) {
    throw new GitCommandError('Hosted checkout escaped its temporary root.');
  }
}

function repositoryUrl(owner: string, repository: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}.git`;
}

async function verifyRevision(
  runGit: HostedGitRunner,
  repositoryRoot: string,
  reference: string,
  expectedSha: string,
  githubToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const actualSha = (await runGit(
    repositoryRoot,
    ['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`],
    { githubToken, signal },
  )).trim();
  if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new GitCommandError('Fetched revision does not match the durable review run.');
  }
}

export async function withHostedGitHubCheckout<T>(
  input: unknown,
  operation: (repositoryRoot: string) => Promise<T>,
  options: HostedCheckoutOptions = {},
): Promise<T> {
  const checkout = checkoutSchema.parse(input);
  const runGit = options.runGit ?? runGitText;
  const temporaryRoot = await realpath(options.temporaryRoot ?? tmpdir());
  const workspace = await mkdtemp(join(temporaryRoot, 'walkz-review-'));
  assertTemporaryChild(temporaryRoot, workspace);
  const repositoryRoot = join(workspace, 'repository');

  try {
    await mkdir(repositoryRoot);
    await runGit(repositoryRoot, ['init', '--quiet'], { signal: options.signal });
    await runGit(
      repositoryRoot,
      ['remote', 'add', 'origin', repositoryUrl(checkout.owner, checkout.repository)],
      { signal: options.signal },
    );
    await runGit(
      repositoryRoot,
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--filter=blob:none',
        '--depth=1000',
        'origin',
        `+${checkout.baseSha}:refs/walkz/base`,
        `+${checkout.headSha}:refs/walkz/head`,
      ],
      {
        githubToken: checkout.githubToken,
        signal: options.signal,
        timeoutMs: 120_000,
      },
    );
    await verifyRevision(
      runGit,
      repositoryRoot,
      'refs/walkz/base',
      checkout.baseSha,
      checkout.githubToken,
      options.signal,
    );
    await verifyRevision(
      runGit,
      repositoryRoot,
      'refs/walkz/head',
      checkout.headSha,
      checkout.githubToken,
      options.signal,
    );
    await runGit(
      repositoryRoot,
      ['checkout', '--quiet', '--detach', 'refs/walkz/head'],
      { githubToken: checkout.githubToken, signal: options.signal },
    );
    return await operation(repositoryRoot);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
