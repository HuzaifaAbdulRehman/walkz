import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultWalkzConfig } from '@walkz/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCommandPlan,
  discoverRepositoryCommands,
} from '../src/index.js';

const temporaryDirectories = new Set<string>();

async function temporaryRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'walkz commands test '));
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

describe('discoverRepositoryCommands', () => {
  it('finds only the standard npm scripts in a stable order', async () => {
    const repository = await temporaryRepository();
    await writeFile(
      join(repository, 'package.json'),
      JSON.stringify({
        scripts: {
          build: 'tsc',
          custom: 'node custom.mjs',
          test: 'vitest',
          lint: 'eslint .',
        },
      }),
    );

    const commands = await discoverRepositoryCommands(repository);

    expect(commands.map((command) => command.id)).toEqual([
      'lint',
      'test',
      'build',
    ]);
    expect(commands[0]).toMatchObject({
      executable: 'npm',
      args: ['run', 'lint'],
      cwd: '.',
      required: true,
    });
  });

  it('returns no commands when package.json is absent', async () => {
    const repository = await temporaryRepository();

    expect(await discoverRepositoryCommands(repository)).toEqual([]);
  });

  it('rejects malformed or oversized package manifests', async () => {
    const malformedRepository = await temporaryRepository();
    const oversizedRepository = await temporaryRepository();
    await writeFile(join(malformedRepository, 'package.json'), '{broken');
    await writeFile(
      join(oversizedRepository, 'package.json'),
      ' '.repeat(256 * 1_024 + 1),
    );

    await expect(
      discoverRepositoryCommands(malformedRepository),
    ).rejects.toThrow('not valid JSON');
    await expect(
      discoverRepositoryCommands(oversizedRepository),
    ).rejects.toThrow('too large');
  });
});

describe('buildCommandPlan', () => {
  it('applies repository limits without changing command arguments', () => {
    const config = createDefaultWalkzConfig([
      {
        id: 'test',
        executable: 'npm',
        args: ['run', 'test'],
        cwd: '.',
        required: true,
      },
    ]);

    expect(buildCommandPlan(config, 'C:\\repo')).toEqual([
      {
        executable: 'npm',
        args: ['run', 'test'],
        repositoryRoot: 'C:\\repo',
        cwd: '.',
        timeoutMs: 120_000,
        maxOutputBytesPerStream: 262_144,
      },
    ]);
  });
});
