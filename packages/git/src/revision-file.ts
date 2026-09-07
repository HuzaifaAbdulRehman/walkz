import { isUtf8 } from 'node:buffer';

import {
  GitCommandError,
  GitOutputLimitError,
  runGitBuffer,
} from './process.js';
import { assertCommitSha } from './validation.js';

function validatePath(path: string): void {
  if (
    path.length === 0 ||
    /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path) ||
    path.includes('\0') ||
    path.split(/[\\/]/).some((part) => part === '..')
  ) {
    throw new GitCommandError('Repository file path is invalid.');
  }
}

export async function readRepositoryFileAtRevision(
  repositoryRoot: string,
  sha: string,
  path: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | null> {
  assertCommitSha(sha);
  validatePath(path);
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Repository file budget must be a positive integer.');
  }

  const metadata = await runGitBuffer(
    repositoryRoot,
    ['--literal-pathspecs', 'ls-tree', '-z', sha, '--', path],
    { maxOutputBytes: 8 * 1_024, signal },
  );
  if (metadata.length === 0) {
    return null;
  }
  const record = metadata.toString('utf8').split('\0')[0] ?? '';
  const match = /^(\d{6}) ([a-z]+) [0-9a-f]+\t/.exec(record);
  if (
    match === null ||
    match[2] !== 'blob' ||
    (match[1] !== '100644' && match[1] !== '100755')
  ) {
    throw new GitCommandError(
      'Repository file must be a regular blob at the trusted revision.',
    );
  }

  let content: Buffer;
  try {
    content = await runGitBuffer(
      repositoryRoot,
      ['cat-file', 'blob', sha + ':' + path],
      { maxOutputBytes: maxBytes, signal },
    );
  } catch (error) {
    if (error instanceof GitOutputLimitError) {
      throw new GitCommandError(
        'Repository file exceeds its configured byte limit.',
      );
    }
    throw error;
  }
  if (!isUtf8(content)) {
    throw new GitCommandError('Repository file is not valid UTF-8.');
  }
  return content.toString('utf8');
}
