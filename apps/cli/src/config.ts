import { constants } from 'node:fs';
import { lstat, open, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  parseWalkzConfig,
  type RepositoryConfig,
} from '@walkz/contracts';
import { ZodError } from 'zod';

export const WALKZ_CONFIG_FILENAME = 'walkz.config.json';
const CONFIG_LIMIT_BYTES = 256 * 1_024;

export type WalkzConfigErrorKind =
  | 'missing'
  | 'invalid'
  | 'unsafe'
  | 'too_large'
  | 'exists';

export class WalkzConfigError extends Error {
  constructor(
    readonly kind: WalkzConfigErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'WalkzConfigError';
  }
}

function isInsideRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith('..\\') &&
    !pathFromRoot.startsWith('../') &&
    !isAbsolute(pathFromRoot)
  );
}

function formatSchemaError(error: ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length === 0 ? 'config' : issue.path.join('.');
      return path + ': ' + issue.message;
    })
    .join(' ');
}

async function readBoundedConfig(configPath: string): Promise<string> {
  const handle = await open(
    configPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const openedFileStats = await handle.stat();
    if (!openedFileStats.isFile()) {
      throw new WalkzConfigError(
        'unsafe',
        WALKZ_CONFIG_FILENAME + ' must be a regular file.',
      );
    }
    if (openedFileStats.size > CONFIG_LIMIT_BYTES) {
      throw new WalkzConfigError(
        'too_large',
        WALKZ_CONFIG_FILENAME + ' exceeds the 256 KiB safety limit.',
      );
    }

    const buffer = Buffer.alloc(CONFIG_LIMIT_BYTES + 1);
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

    if (totalBytes > CONFIG_LIMIT_BYTES) {
      throw new WalkzConfigError(
        'too_large',
        WALKZ_CONFIG_FILENAME + ' exceeds the 256 KiB safety limit.',
      );
    }
    return buffer.subarray(0, totalBytes).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function loadWalkzConfig(
  repositoryRoot: string,
): Promise<RepositoryConfig> {
  const root = await realpath(repositoryRoot);
  const configPath = resolve(root, WALKZ_CONFIG_FILENAME);
  let fileStats;

  try {
    fileStats = await lstat(configPath);
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      throw new WalkzConfigError(
        'missing',
        WALKZ_CONFIG_FILENAME + ' does not exist. Run "walkz init" first.',
      );
    }
    throw error;
  }

  if (fileStats.isSymbolicLink()) {
    throw new WalkzConfigError(
      'unsafe',
      WALKZ_CONFIG_FILENAME + ' cannot be a symbolic link.',
    );
  }
  if (!fileStats.isFile()) {
    throw new WalkzConfigError(
      'unsafe',
      WALKZ_CONFIG_FILENAME + ' must be a regular file.',
    );
  }
  if (fileStats.size > CONFIG_LIMIT_BYTES) {
    throw new WalkzConfigError(
      'too_large',
      WALKZ_CONFIG_FILENAME + ' exceeds the 256 KiB safety limit.',
    );
  }

  const resolvedConfigPath = await realpath(configPath);
  if (!isInsideRoot(root, resolvedConfigPath)) {
    throw new WalkzConfigError(
      'unsafe',
      WALKZ_CONFIG_FILENAME + ' must stay inside the repository.',
    );
  }

  let input: unknown;
  try {
    input = JSON.parse(await readBoundedConfig(resolvedConfigPath));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new WalkzConfigError(
        'invalid',
        WALKZ_CONFIG_FILENAME + ' is not valid JSON.',
      );
    }
    throw error;
  }

  try {
    return parseWalkzConfig(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new WalkzConfigError(
        'invalid',
        WALKZ_CONFIG_FILENAME + ' is invalid. ' + formatSchemaError(error),
      );
    }
    throw error;
  }
}

export async function writeWalkzConfig(
  repositoryRoot: string,
  config: RepositoryConfig,
): Promise<string> {
  const root = await realpath(repositoryRoot);
  const configPath = resolve(root, WALKZ_CONFIG_FILENAME);
  const contents = JSON.stringify(parseWalkzConfig(config), null, 2) + '\n';

  try {
    await writeFile(configPath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      throw new WalkzConfigError(
        'exists',
        WALKZ_CONFIG_FILENAME + ' already exists. Walkz left it unchanged.',
      );
    }
    throw error;
  }

  return configPath;
}
