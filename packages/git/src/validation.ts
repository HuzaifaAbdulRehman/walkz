import { isAbsolute } from 'node:path';

import { GitCommandError } from './process.js';

const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

export function assertCommitSha(value: string): void {
  if (!SHA_PATTERN.test(value)) {
    throw new GitCommandError('Commit identifier is invalid.');
  }
}

export function assertRepositoryPath(path: string): void {
  const normalized = path.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.includes('\0') ||
    isAbsolute(path) ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new GitCommandError('Repository path is unsafe.');
  }
}
