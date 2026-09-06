import { isUtf8 } from 'node:buffer';

import { GitCommandError, GitOutputLimitError, runGitBuffer } from './process.js';
import type {
  RepositoryGuidance,
  RepositoryGuidanceDocument,
  RepositoryGuidanceOmission,
  ResolvedGitReferences,
} from './types.js';
import { assertCommitSha } from './validation.js';

const GUIDANCE_PATHS = [
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  '.github/copilot-instructions.md',
] as const;

export interface LoadRepositoryGuidanceOptions {
  maxBytes?: number;
  signal?: AbortSignal | undefined;
}

interface TreeEntry {
  mode: string;
  type: string;
}

async function readTreeEntry(
  repositoryRoot: string,
  sha: string,
  path: string,
  signal?: AbortSignal,
): Promise<TreeEntry | null> {
  const output = await runGitBuffer(
    repositoryRoot,
    ['--literal-pathspecs', 'ls-tree', '-z', sha, '--', path],
    { maxOutputBytes: 8 * 1024, signal },
  );
  if (output.length === 0) {
    return null;
  }
  const record = output.toString('utf8').split('\0')[0];
  const match = /^(\d{6}) ([a-z]+) [0-9a-f]+\t/.exec(record ?? '');
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new GitCommandError('Git returned malformed guidance metadata.');
  }
  return { mode: match[1], type: match[2] };
}

export async function loadRepositoryGuidance(
  repositoryRoot: string,
  references: ResolvedGitReferences,
  options: LoadRepositoryGuidanceOptions = {},
): Promise<RepositoryGuidance> {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Guidance budget must be a positive integer.');
  }
  assertCommitSha(references.guidanceSha);
  const documents: RepositoryGuidanceDocument[] = [];
  const omissions: RepositoryGuidanceOmission[] = [];
  let bytes = 0;

  for (const path of GUIDANCE_PATHS) {
    const entry = await readTreeEntry(
      repositoryRoot,
      references.guidanceSha,
      path,
      options.signal,
    );
    if (entry === null) {
      continue;
    }
    if (
      entry.type !== 'blob' ||
      (entry.mode !== '100644' && entry.mode !== '100755')
    ) {
      omissions.push({ path, reason: 'unsafe_type' });
      continue;
    }
    const remainingBytes = maxBytes - bytes;
    if (remainingBytes < 1) {
      omissions.push({ path, reason: 'budget' });
      continue;
    }
    try {
      const content = await runGitBuffer(
        repositoryRoot,
        ['cat-file', 'blob', references.guidanceSha + ':' + path],
        { maxOutputBytes: remainingBytes, signal: options.signal },
      );
      if (!isUtf8(content)) {
        omissions.push({ path, reason: 'invalid_encoding' });
        continue;
      }
      documents.push({
        path,
        content: content.toString('utf8'),
        bytes: content.length,
        sourceSha: references.guidanceSha,
      });
      bytes += content.length;
    } catch (error) {
      if (error instanceof GitOutputLimitError) {
        omissions.push({ path, reason: 'budget' });
        continue;
      }
      throw error;
    }
  }

  return { documents, bytes, omissions };
}
