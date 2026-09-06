import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type {
  ApprovedCommand,
  CommandSpec,
  RepositoryConfig,
} from '@walkz/contracts';

const PACKAGE_JSON_LIMIT_BYTES = 256 * 1_024;
const STANDARD_SCRIPT_NAMES = ['lint', 'typecheck', 'test', 'build'] as const;

function isInsideRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith('..\\') &&
    !pathFromRoot.startsWith('../') &&
    !isAbsolute(pathFromRoot)
  );
}

async function readBoundedManifest(packageJsonPath: string): Promise<string> {
  const handle = await open(
    packageJsonPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const openedFileStats = await handle.stat();
    if (!openedFileStats.isFile()) {
      throw new Error('package.json must be a regular file.');
    }
    if (openedFileStats.size > PACKAGE_JSON_LIMIT_BYTES) {
      throw new Error('package.json is too large to inspect safely.');
    }

    const buffer = Buffer.alloc(PACKAGE_JSON_LIMIT_BYTES + 1);
    let totalBytes = 0;

    while (totalBytes < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalBytes,
        buffer.length - totalBytes,
        totalBytes,
      );
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
    }

    if (totalBytes > PACKAGE_JSON_LIMIT_BYTES) {
      throw new Error('package.json is too large to inspect safely.');
    }
    return buffer.subarray(0, totalBytes).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function discoverRepositoryCommands(
  repositoryRoot: string,
): Promise<ApprovedCommand[]> {
  const root = await realpath(repositoryRoot);
  const packageJsonCandidate = resolve(root, 'package.json');
  let packageJsonPath: string;

  try {
    packageJsonPath = await realpath(packageJsonCandidate);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }

  if (!isInsideRoot(root, packageJsonPath)) {
    throw new Error('package.json must stay inside the repository.');
  }

  const packageStats = await stat(packageJsonPath);
  if (!packageStats.isFile()) {
    throw new Error('package.json must be a regular file.');
  }
  if (packageStats.size > PACKAGE_JSON_LIMIT_BYTES) {
    throw new Error('package.json is too large to inspect safely.');
  }

  let manifestText: string;
  try {
    manifestText = await readBoundedManifest(packageJsonPath);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'package.json is too large to inspect safely.'
    ) {
      throw error;
    }
    throw new Error(
      'package.json could not be read. ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error('package.json is not valid JSON.');
  }

  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !('scripts' in manifest) ||
    typeof manifest.scripts !== 'object' ||
    manifest.scripts === null
  ) {
    return [];
  }

  return STANDARD_SCRIPT_NAMES.filter(
    (name) =>
      Object.prototype.hasOwnProperty.call(manifest.scripts, name) &&
      typeof (manifest.scripts as Record<string, unknown>)[name] === 'string',
  ).map((name) => ({
    id: name,
    executable: 'npm',
    args: ['run', name],
    cwd: '.',
    required: true,
  }));
}

export function buildCommandPlan(
  config: RepositoryConfig,
  repositoryRoot: string,
): CommandSpec[] {
  return config.commands.map((command) => ({
    executable: command.executable,
    args: command.args,
    repositoryRoot,
    cwd: command.cwd,
    timeoutMs: config.commandTimeoutMs,
    maxOutputBytesPerStream: config.commandOutputBytesPerStream,
  }));
}
