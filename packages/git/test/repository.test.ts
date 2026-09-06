import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { locateRepositoryRoot } from '../src/index.js';

const temporaryDirectories = new Set<string>();

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'walkz git test '));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('locateRepositoryRoot', () => {
  it('walks up from a nested directory', async () => {
    const root = await temporaryDirectory();
    const nested = join(root, 'folder with spaces', 'child');
    await mkdir(join(root, '.git'));
    await mkdir(nested, { recursive: true });

    expect(await locateRepositoryRoot(nested)).toBe(await realpath(root));
  });

  it('accepts a worktree .git file', async () => {
    const root = await temporaryDirectory();
    await writeFile(
      join(root, '.git'),
      'gitdir: ../main/.git/worktrees/example\n',
    );

    expect(await locateRepositoryRoot(root)).toBe(await realpath(root));
  });

  it('fails clearly outside a repository', async () => {
    const directory = await temporaryDirectory();

    await expect(locateRepositoryRoot(directory)).rejects.toThrow(
      'No Git repository',
    );
  });
});
