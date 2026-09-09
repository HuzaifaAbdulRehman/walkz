import { describe, expect, it } from 'vitest';

import { GitCommandError, runGitBuffer } from '../src/process.js';
import { GitFixture } from './git-fixture.js';

describe('runGitBuffer input', () => {
  it('feeds bounded bytes to a Git batch command', async () => {
    const repository = await GitFixture.create();
    try {
      await repository.write('value.txt', 'value\n');
      await repository.commitAll('base');
      const objectId = repository.git('rev-parse', 'HEAD:value.txt');

      const output = await runGitBuffer(
        repository.root,
        ['cat-file', '--batch'],
        { input: Buffer.from(objectId + '\n', 'ascii') },
      );

      expect(output.subarray(0, output.indexOf(0x0a)).toString('ascii'))
        .toBe(objectId + ' blob 6');
      expect(output.subarray(output.indexOf(0x0a) + 1).toString('utf8'))
        .toBe('value\n\n');
    } finally {
      await repository.dispose();
    }
  });

  it('rejects oversized input before starting Git', async () => {
    const repository = await GitFixture.create();
    try {
      await expect(
        runGitBuffer(repository.root, ['cat-file', '--batch'], {
          input: Buffer.alloc(2 * 1_024 * 1_024 + 1),
        }),
      ).rejects.toEqual(
        expect.objectContaining<Partial<GitCommandError>>({
          name: 'GitCommandError',
          message: 'Git input exceeded its configured byte limit.',
        }),
      );
    } finally {
      await repository.dispose();
    }
  });

  it('rejects header injection in GitHub credentials', async () => {
    const repository = await GitFixture.create();
    try {
      await expect(runGitBuffer(repository.root, ['status'], {
        githubToken: 'token\r\nInjected: value',
      })).rejects.toThrow('installation token is invalid');
    } finally {
      await repository.dispose();
    }
  });
});
