import { lstat, realpath } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    const marker = await lstat(resolve(directory, '.git'));
    return marker.isDirectory() || marker.isFile();
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false;
    }
    throw error;
  }
}

export async function locateRepositoryRoot(startDirectory: string): Promise<string> {
  let currentDirectory = await realpath(startDirectory);
  const root = parse(currentDirectory).root;

  while (true) {
    if (await hasGitMarker(currentDirectory)) {
      return currentDirectory;
    }
    if (currentDirectory === root) {
      throw new Error('No Git repository was found from the current directory.');
    }
    currentDirectory = dirname(currentDirectory);
  }
}
