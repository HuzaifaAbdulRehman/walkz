import { isUtf8 } from 'node:buffer';

import { comparisonArguments } from './comparison.js';
import { GitCommandError, runGitBuffer } from './process.js';
import type {
  ChangedFile,
  ChangedFileKind,
  ChangedFileStatus,
  ResolvedGitReferences,
} from './types.js';
import { assertRepositoryPath } from './validation.js';

const METADATA_LIMIT_BYTES = 16 * 1024 * 1024;
const RAW_RECORD_PATTERN =
  /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/;

interface RawChangedFile {
  path: string;
  oldPath?: string;
  statusCode: string;
  status: ChangedFileStatus;
  similarity?: number;
  oldMode: string;
  newMode: string;
}

interface FileStatistics {
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

function statusFromCode(code: string): ChangedFileStatus {
  switch (code) {
    case 'A':
      return 'added';
    case 'C':
      return 'copied';
    case 'D':
      return 'deleted';
    case 'M':
      return 'modified';
    case 'R':
      return 'renamed';
    case 'T':
      return 'type_changed';
    case 'U':
      return 'unmerged';
    default:
      return 'unknown';
  }
}

function parseRawChanges(output: Buffer): RawChangedFile[] {
  if (!isUtf8(output)) {
    throw new GitCommandError('Git returned a path that is not valid UTF-8.');
  }
  const records = output.toString('utf8').split('\0');
  const files: RawChangedFile[] = [];
  let index = 0;

  while (index < records.length - 1) {
    const metadata = records[index++];
    const firstPath = records[index++];
    if (metadata === undefined || firstPath === undefined) {
      throw new GitCommandError('Git returned an incomplete changed-file record.');
    }
    const match = RAW_RECORD_PATTERN.exec(metadata);
    if (match === null) {
      throw new GitCommandError('Git returned a malformed changed-file record.');
    }
    const [, oldMode, newMode, , , statusCode, similarityText] = match;
    if (
      oldMode === undefined ||
      newMode === undefined ||
      statusCode === undefined ||
      similarityText === undefined
    ) {
      throw new GitCommandError('Git omitted changed-file metadata.');
    }

    let path = firstPath;
    let oldPath: string | undefined;
    if (statusCode === 'R' || statusCode === 'C') {
      oldPath = firstPath;
      const secondPath = records[index++];
      if (secondPath === undefined || secondPath.length === 0) {
        throw new GitCommandError('Git omitted a rename destination.');
      }
      path = secondPath;
    }
    assertRepositoryPath(path);
    if (oldPath !== undefined) {
      assertRepositoryPath(oldPath);
    }

    const similarity =
      similarityText.length > 0
        ? Number.parseInt(similarityText, 10)
        : undefined;
    if (similarity !== undefined && (similarity < 0 || similarity > 100)) {
      throw new GitCommandError('Git returned an invalid similarity score.');
    }

    files.push({
      path,
      ...(oldPath !== undefined && { oldPath }),
      statusCode,
      status: statusFromCode(statusCode),
      ...(similarity !== undefined && { similarity }),
      oldMode,
      newMode,
    });
  }
  return files;
}

function parseCount(value: string): number | null {
  if (value === '-') {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    throw new GitCommandError('Git returned an invalid line count.');
  }
  const count = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(count)) {
    throw new GitCommandError('Git returned an unsafe line count.');
  }
  return count;
}

function parseNumstat(output: Buffer): Map<string, FileStatistics> {
  if (!isUtf8(output)) {
    throw new GitCommandError('Git returned a path that is not valid UTF-8.');
  }
  const records = output.toString('utf8').split('\0');
  const statistics = new Map<string, FileStatistics>();
  let index = 0;

  while (index < records.length - 1) {
    const record = records[index++];
    if (record === undefined) {
      throw new GitCommandError('Git returned an incomplete line-count record.');
    }
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw new GitCommandError('Git returned a malformed line-count record.');
    }
    const additions = parseCount(record.slice(0, firstTab));
    const deletions = parseCount(record.slice(firstTab + 1, secondTab));
    let path = record.slice(secondTab + 1);
    if (path.length === 0) {
      const oldPath = records[index++];
      const newPath = records[index++];
      if (oldPath === undefined || newPath === undefined || newPath.length === 0) {
        throw new GitCommandError('Git omitted line-count rename paths.');
      }
      assertRepositoryPath(oldPath);
      path = newPath;
    }
    assertRepositoryPath(path);
    statistics.set(path, {
      additions,
      deletions,
      binary: additions === null || deletions === null,
    });
  }
  return statistics;
}

function fileKind(
  file: RawChangedFile,
  binary: boolean,
): ChangedFileKind {
  const effectiveMode = file.newMode === '000000' ? file.oldMode : file.newMode;
  if (effectiveMode === '120000') {
    return 'symlink';
  }
  if (effectiveMode === '160000') {
    return 'submodule';
  }
  return binary ? 'binary' : 'text';
}

export async function collectChangedFiles(
  repositoryRoot: string,
  references: ResolvedGitReferences,
  signal?: AbortSignal,
): Promise<ChangedFile[]> {
  const comparison = comparisonArguments(references);
  const commonOptions = [
    '--find-renames',
    '--no-ext-diff',
    '--no-textconv',
    ...comparison,
  ];
  const [rawOutput, numstatOutput] = await Promise.all([
    runGitBuffer(
      repositoryRoot,
      ['--literal-pathspecs', 'diff', '--raw', '-z', '--no-abbrev', ...commonOptions],
      { maxOutputBytes: METADATA_LIMIT_BYTES, signal },
    ),
    runGitBuffer(
      repositoryRoot,
      ['--literal-pathspecs', 'diff', '--numstat', '-z', ...commonOptions],
      { maxOutputBytes: METADATA_LIMIT_BYTES, signal },
    ),
  ]);
  const rawFiles = parseRawChanges(rawOutput);
  const statistics = parseNumstat(numstatOutput);

  return rawFiles.map((file) => {
    const counts = statistics.get(file.path);
    if (counts === undefined) {
      throw new GitCommandError('Git omitted line counts for a changed file.');
    }
    return {
      ...file,
      additions: counts.additions,
      deletions: counts.deletions,
      kind: fileKind(file, counts.binary),
    };
  });
}
