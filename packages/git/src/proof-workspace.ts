import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

import {
  GitCommandError,
  GitOutputLimitError,
  runGitBuffer,
  type RunGitOptions,
} from './process.js';
import { assertCommitSha } from './validation.js';

const MAX_WORKSPACE_FILES = 20_000;
const MAX_WORKSPACE_BYTES = 256 * 1_024 * 1_024;
const MAX_PATH_BYTES = 1_024;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

interface TreeBlob {
  mode: '100644' | '100755';
  objectId: string;
  path: string;
  size: number;
}

export interface ProofWorkspaceLimits {
  maxFiles: number;
  maxBytes: number;
  gitTimeoutMs?: number | undefined;
}

export interface ProofWorkspace {
  revision: 'base' | 'head';
  sha: string;
  path: string;
  fileCount: number;
  totalBytes: number;
  manifestDigest: string;
}

export interface ProofWorkspacePair {
  rootPath: string;
  base: ProofWorkspace;
  head: ProofWorkspace;
}

export interface WithProofWorkspacesOptions {
  repositoryRoot: string;
  baseSha: string;
  headSha: string;
  limits: ProofWorkspaceLimits;
  signal?: AbortSignal | undefined;
  temporaryRoot?: string | undefined;
  githubToken?: string | undefined;
  runGit?: ProofGitRunner | undefined;
}

export type ProofGitRunner = (
  repositoryRoot: string,
  args: readonly string[],
  options?: RunGitOptions,
) => Promise<Buffer>;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new GitCommandError('Proof workspace creation was cancelled.');
  }
}

function validateLimits(limits: ProofWorkspaceLimits): void {
  if (
    !Number.isSafeInteger(limits.maxFiles) ||
    limits.maxFiles < 1 ||
    limits.maxFiles > MAX_WORKSPACE_FILES
  ) {
    throw new GitCommandError(
      'Proof workspace file limit must be between 1 and 20000.',
    );
  }
  if (
    !Number.isSafeInteger(limits.maxBytes) ||
    limits.maxBytes < 1 ||
    limits.maxBytes > MAX_WORKSPACE_BYTES
  ) {
    throw new GitCommandError(
      'Proof workspace byte limit must be between 1 and 268435456.',
    );
  }
}

export function assertProofWorkspacePath(path: string): void {
  if (
    path.length === 0 ||
    Buffer.byteLength(path) > MAX_PATH_BYTES ||
    path.startsWith('/') ||
    path.includes('\\') ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new GitCommandError('Proof workspace contains an unsafe path.');
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      segment.includes(':') ||
      WINDOWS_RESERVED_NAME.test(segment) ||
      segment.toLowerCase() === '.git' ||
      segment.toLowerCase() === '.walkz-proof'
    ) {
      throw new GitCommandError('Proof workspace contains an unsafe path.');
    }
  }
}

export function assertProofWorkspacePaths(
  paths: readonly string[],
): void {
  const observed = new Map<string, string>();
  for (const path of paths) {
    assertProofWorkspacePath(path);
    const segments = path.split('/');
    for (let index = 1; index <= segments.length; index += 1) {
      const prefix = segments.slice(0, index).join('/');
      const key = prefix.toLowerCase();
      const existing = observed.get(key);
      if (existing !== undefined && existing !== prefix) {
        throw new GitCommandError(
          'Proof workspace paths collide across supported platforms.',
        );
      }
      observed.set(key, prefix);
    }
  }
}

function parseTree(output: Buffer, limits: ProofWorkspaceLimits): TreeBlob[] {
  if (!isUtf8(output)) {
    throw new GitCommandError('Git tree paths must be valid UTF-8.');
  }
  const records = output.toString('utf8').split('\0');
  if (records.at(-1) !== '') {
    throw new GitCommandError('Git tree output was not NUL terminated.');
  }
  records.pop();
  if (records.length > limits.maxFiles) {
    throw new GitCommandError('Proof workspace exceeds its file limit.');
  }

  let totalBytes = 0;
  const blobs = records.map((record): TreeBlob => {
    const match = /^(\d{6}) ([a-z]+) ([a-f0-9]{40,64}) +([0-9-]+)\t([\s\S]+)$/.exec(
      record,
    );
    if (match === null) {
      throw new GitCommandError('Git tree output is malformed.');
    }
    const [, mode, type, objectId, rawSize, path] = match;
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      throw new GitCommandError(
        'Proof workspaces do not permit links, submodules, or special files.',
      );
    }
    if (path === undefined || objectId === undefined || rawSize === undefined) {
      throw new GitCommandError('Git tree output is incomplete.');
    }
    assertProofWorkspacePath(path);
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new GitCommandError('Git reported an invalid blob size.');
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxBytes) {
      throw new GitCommandError('Proof workspace exceeds its byte limit.');
    }
    return { mode, objectId, path, size };
  });
  assertProofWorkspacePaths(blobs.map((blob) => blob.path));
  return blobs;
}

function parseBatch(
  output: Buffer,
  expected: readonly TreeBlob[],
): ReadonlyMap<string, Buffer> {
  const objects = new Map<string, Buffer>();
  let offset = 0;
  for (const blob of expected) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) {
      throw new GitCommandError('Git object batch ended before its header.');
    }
    const header = output.subarray(offset, newline).toString('ascii');
    const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/.exec(header);
    if (
      match === null ||
      match[1] !== blob.objectId ||
      Number(match[2]) !== blob.size
    ) {
      throw new GitCommandError('Git object batch did not match the tree.');
    }
    const start = newline + 1;
    const end = start + blob.size;
    if (end >= output.length || output[end] !== 0x0a) {
      throw new GitCommandError('Git object batch ended inside a blob.');
    }
    objects.set(blob.objectId, output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length) {
    throw new GitCommandError('Git object batch contained unexpected data.');
  }
  return objects;
}

function manifestDigest(blobs: readonly TreeBlob[]): string {
  const hash = createHash('sha256');
  for (const blob of blobs) {
    hash.update(blob.path, 'utf8');
    hash.update('\0');
    hash.update(blob.mode, 'ascii');
    hash.update('\0');
    hash.update(blob.objectId, 'ascii');
    hash.update('\0');
    hash.update(String(blob.size), 'ascii');
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function listTree(
  repositoryRoot: string,
  sha: string,
  limits: ProofWorkspaceLimits,
  signal?: AbortSignal,
  githubToken?: string,
  runGit: ProofGitRunner = runGitBuffer,
): Promise<TreeBlob[]> {
  const maxTreeBytes = Math.min(
    32 * 1_024 * 1_024,
    limits.maxFiles * (MAX_PATH_BYTES + 128) + 1,
  );
  try {
    const output = await runGit(
      repositoryRoot,
      ['ls-tree', '-rlz', '--full-tree', sha],
      {
        maxOutputBytes: maxTreeBytes,
        signal,
        githubToken,
        ...(limits.gitTimeoutMs !== undefined && {
          timeoutMs: limits.gitTimeoutMs,
        }),
      },
    );
    return parseTree(output, limits);
  } catch (error) {
    if (error instanceof GitOutputLimitError) {
      throw new GitCommandError('Proof workspace tree exceeds its metadata limit.');
    }
    throw error;
  }
}

async function readBlobs(
  repositoryRoot: string,
  blobs: readonly TreeBlob[],
  limits: ProofWorkspaceLimits,
  signal?: AbortSignal,
  githubToken?: string,
  runGit: ProofGitRunner = runGitBuffer,
): Promise<ReadonlyMap<string, Buffer>> {
  if (blobs.length === 0) {
    return new Map();
  }
  const input = Buffer.from(
    blobs.map((blob) => blob.objectId).join('\n') + '\n',
    'ascii',
  );
  const headerAllowance = blobs.length * 128;
  try {
    const output = await runGit(
      repositoryRoot,
      ['cat-file', '--batch'],
      {
        input,
        maxOutputBytes: limits.maxBytes + headerAllowance,
        signal,
        githubToken,
        ...(limits.gitTimeoutMs !== undefined && {
          timeoutMs: limits.gitTimeoutMs,
        }),
      },
    );
    return parseBatch(output, blobs);
  } catch (error) {
    if (error instanceof GitOutputLimitError) {
      throw new GitCommandError('Proof workspace blobs exceed their byte limit.');
    }
    throw error;
  }
}

function containedPath(root: string, repositoryPath: string): string {
  const target = resolve(root, ...repositoryPath.split('/'));
  const fromRoot = relative(root, target);
  if (
    fromRoot.length === 0 ||
    fromRoot.startsWith('..') ||
    isAbsolute(fromRoot)
  ) {
    throw new GitCommandError('Proof workspace path escaped its root.');
  }
  return target;
}

async function materializeRevision(
  repositoryRoot: string,
  rootPath: string,
  revision: 'base' | 'head',
  sha: string,
  limits: ProofWorkspaceLimits,
  signal?: AbortSignal,
  githubToken?: string,
  runGit: ProofGitRunner = runGitBuffer,
): Promise<ProofWorkspace> {
  throwIfAborted(signal);
  const blobs = await listTree(
    repositoryRoot,
    sha,
    limits,
    signal,
    githubToken,
    runGit,
  );
  const contents = await readBlobs(
    repositoryRoot,
    blobs,
    limits,
    signal,
    githubToken,
    runGit,
  );
  let totalBytes = 0;
  for (const blob of blobs) {
    throwIfAborted(signal);
    const target = containedPath(rootPath, blob.path);
    await mkdir(dirname(target), { recursive: true });
    const content = contents.get(blob.objectId);
    if (content === undefined || content.byteLength !== blob.size) {
      throw new GitCommandError('A proof workspace blob is missing.');
    }
    await writeFile(target, content, { flag: 'wx' });
    if (blob.mode === '100755' && process.platform !== 'win32') {
      await chmod(target, 0o755);
    }
    totalBytes += content.byteLength;
  }
  return {
    revision,
    sha,
    path: rootPath,
    fileCount: blobs.length,
    totalBytes,
    manifestDigest: manifestDigest(blobs),
  };
}

async function resolveTemporaryRoot(path: string): Promise<string> {
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory()) {
    throw new GitCommandError('Proof temporary root must be a directory.');
  }
  return root;
}

async function cleanupProofRoot(
  temporaryRoot: string,
  proofRoot: string,
): Promise<void> {
  const fromTemporaryRoot = relative(temporaryRoot, proofRoot);
  if (
    fromTemporaryRoot.length === 0 ||
    fromTemporaryRoot.startsWith('..') ||
    isAbsolute(fromTemporaryRoot)
  ) {
    throw new GitCommandError('Refusing to clean an unsafe proof path.');
  }
  await rm(proofRoot, { recursive: true, force: true });
}

export async function withProofWorkspaces<T>(
  options: WithProofWorkspacesOptions,
  operation: (workspaces: ProofWorkspacePair) => Promise<T>,
): Promise<T> {
  assertCommitSha(options.baseSha);
  assertCommitSha(options.headSha);
  if (options.baseSha.toLowerCase() === options.headSha.toLowerCase()) {
    throw new GitCommandError('Proof base and head revisions must differ.');
  }
  validateLimits(options.limits);
  throwIfAborted(options.signal);
  const temporaryRoot = await resolveTemporaryRoot(
    options.temporaryRoot ?? tmpdir(),
  );
  const proofRoot = await mkdtemp(join(temporaryRoot, 'walkz proof '));
  try {
    if (process.platform !== 'win32') {
      await chmod(proofRoot, 0o700);
    }
    const basePath = join(proofRoot, 'base');
    const headPath = join(proofRoot, 'head');
    await Promise.all([mkdir(basePath), mkdir(headPath)]);
    const base = await materializeRevision(
      options.repositoryRoot,
      basePath,
      'base',
      options.baseSha,
      options.limits,
      options.signal,
      options.githubToken,
      options.runGit,
    );
    const head = await materializeRevision(
      options.repositoryRoot,
      headPath,
      'head',
      options.headSha,
      options.limits,
      options.signal,
      options.githubToken,
      options.runGit,
    );
    const result = await operation({ rootPath: proofRoot, base, head });
    throwIfAborted(options.signal);
    return result;
  } finally {
    await cleanupProofRoot(temporaryRoot, proofRoot);
  }
}
