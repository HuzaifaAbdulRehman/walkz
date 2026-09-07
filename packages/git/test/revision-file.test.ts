import { afterEach, describe, expect, it } from 'vitest';

import { readRepositoryFileAtRevision } from '../src/index.js';
import { GitFixture } from './git-fixture.js';

const fixtures: GitFixture[] = [];

async function fixture(): Promise<GitFixture> {
  const repository = await GitFixture.create();
  fixtures.push(repository);
  return repository;
}

afterEach(async () => {
  await Promise.all(fixtures.map((repository) => repository.dispose()));
  fixtures.length = 0;
});

describe('readRepositoryFileAtRevision', () => {
  it('reads the committed bytes instead of a working-tree edit', async () => {
    const repository = await fixture();
    await repository.write('walkz.config.json', '{"trusted":true}\n');
    const sha = await repository.commitAll('trusted config');
    await repository.write('walkz.config.json', '{"trusted":false}\n');

    await expect(
      readRepositoryFileAtRevision(
        repository.root,
        sha,
        'walkz.config.json',
        1_024,
      ),
    ).resolves.toBe('{"trusted":true}\n');
  });

  it('rejects symlinks and oversized blobs', async () => {
    const repository = await fixture();
    await repository.write('target.json', '{}\n');
    await repository.write('large.json', 'x'.repeat(2_000));
    await repository.commitAll('files');
    await repository.addIndexSymlink('linked.json', 'target.json');
    repository.git('commit', '--quiet', '-m', 'symlink');
    const symlinkSha = repository.git('rev-parse', 'HEAD');

    await expect(
      readRepositoryFileAtRevision(
        repository.root,
        symlinkSha,
        'linked.json',
        1_024,
      ),
    ).rejects.toThrow('regular blob');
    await expect(
      readRepositoryFileAtRevision(
        repository.root,
        symlinkSha,
        'large.json',
        100,
      ),
    ).rejects.toThrow('byte limit');
  });

  it('rejects traversal before invoking Git', async () => {
    const repository = await fixture();
    await repository.write('safe.json', '{}\n');
    const sha = await repository.commitAll('safe');

    await expect(
      readRepositoryFileAtRevision(
        repository.root,
        sha,
        '../outside.json',
        1_024,
      ),
    ).rejects.toThrow('path is invalid');
  });
});
