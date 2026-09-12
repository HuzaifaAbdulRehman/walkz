import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertProofWorkspacePath,
  assertProofWorkspacePaths,
  withProofWorkspaces,
} from '../src/index.js';
import { runGitBuffer } from '../src/process.js';
import { GitFixture } from './git-fixture.js';

const repositories: GitFixture[] = [];
const temporaryRoots: string[] = [];
const limits = {
  maxFiles: 100,
  maxBytes: 1024 * 1_024,
};

async function fixture(): Promise<GitFixture> {
  const repository = await GitFixture.create();
  repositories.push(repository);
  return repository;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'walkz workspace tests '));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all([
    ...repositories.map((repository) => repository.dispose()),
    ...temporaryRoots.map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  ]);
  repositories.length = 0;
  temporaryRoots.length = 0;
});

describe('withProofWorkspaces', () => {
  it.each([
    '/absolute.txt',
    '../outside.txt',
    'nested/../outside.txt',
    'windows\\separator.txt',
    'safe/.git/config',
    'CON.txt',
    'trailing.',
    'stream:name',
  ])('rejects unsafe workspace path %s', (path) => {
    expect(() => assertProofWorkspacePath(path)).toThrow('unsafe path');
  });

  it('rejects paths that collide on case-insensitive filesystems', () => {
    expect(() =>
      assertProofWorkspacePaths(['Source/one.ts', 'source/two.ts']),
    ).toThrow('collide across supported platforms');
  });

  it('materializes exact commits without changing a dirty working tree', async () => {
    const repository = await fixture();
    await repository.write('src/value.txt', 'base\n');
    const baseSha = await repository.commitAll('base');
    await repository.write('src/value.txt', 'head\n');
    await repository.write('dir with spaces/naïve [value].txt', 'kept\n');
    await repository.write('binary.bin', Buffer.from([0, 255, 10]));
    const headSha = await repository.commitAll('head');
    await repository.write('src/value.txt', 'dirty\n');
    const temp = await temporaryRoot();

    await withProofWorkspaces(
      {
        repositoryRoot: repository.root,
        baseSha,
        headSha,
        limits,
        temporaryRoot: temp,
      },
      async (workspaces) => {
        await expect(
          readFile(join(workspaces.base.path, 'src', 'value.txt'), 'utf8'),
        ).resolves.toBe('base\n');
        await expect(
          readFile(join(workspaces.head.path, 'src', 'value.txt'), 'utf8'),
        ).resolves.toBe('head\n');
        await expect(
          readFile(
            join(
              workspaces.head.path,
              'dir with spaces',
              'naïve [value].txt',
            ),
            'utf8',
          ),
        ).resolves.toBe('kept\n');
        await expect(
          readFile(join(workspaces.head.path, 'binary.bin')),
        ).resolves.toEqual(Buffer.from([0, 255, 10]));
        await expect(
          stat(join(workspaces.base.path, '.git')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(workspaces.base.sha).toBe(baseSha);
        expect(workspaces.head.sha).toBe(headSha);
        expect(workspaces.base.fileCount).toBe(1);
        expect(workspaces.base.totalBytes).toBe(5);
        expect(workspaces.head.fileCount).toBe(3);
        expect(workspaces.base.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(workspaces.head.manifestDigest).not.toBe(
          workspaces.base.manifestDigest,
        );
      },
    );

    await expect(readFile(join(repository.root, 'src', 'value.txt'), 'utf8'))
      .resolves.toBe('dirty\n');
    await expect(readdir(temp)).resolves.toEqual([]);
  });

  it('authenticates every object read for a partial hosted clone', async () => {
    const repository = await fixture();
    await repository.write('src/value.txt', 'base\n');
    const baseSha = await repository.commitAll('base');
    await repository.write('src/value.txt', 'head\n');
    const headSha = await repository.commitAll('head');
    const temp = await temporaryRoot();
    const observedTokens: Array<string | undefined> = [];

    await withProofWorkspaces({
      repositoryRoot: repository.root,
      baseSha,
      headSha,
      limits,
      temporaryRoot: temp,
      githubToken: 'installation-token',
      runGit: async (root, args, options) => {
        observedTokens.push(options?.githubToken);
        return runGitBuffer(root, args, options);
      },
    }, async () => undefined);

    expect(observedTokens.length).toBeGreaterThan(0);
    expect(observedTokens).toEqual(
      Array.from({ length: observedTokens.length }, () => 'installation-token'),
    );
  });

  it('cleans both workspaces when the operation fails', async () => {
    const repository = await fixture();
    await repository.write('value.txt', 'base\n');
    const baseSha = await repository.commitAll('base');
    await repository.write('value.txt', 'head\n');
    const headSha = await repository.commitAll('head');
    const temp = await temporaryRoot();

    await expect(
      withProofWorkspaces(
        {
          repositoryRoot: repository.root,
          baseSha,
          headSha,
          limits,
          temporaryRoot: temp,
        },
        async () => {
          throw new Error('operation failed');
        },
      ),
    ).rejects.toThrow('operation failed');
    await expect(readdir(temp)).resolves.toEqual([]);
  });

  it('rejects symlinks and removes partial output', async () => {
    const repository = await fixture();
    await repository.write('target.txt', 'base\n');
    const baseSha = await repository.commitAll('base');
    await repository.addIndexSymlink('linked.txt', 'target.txt');
    repository.git('commit', '--quiet', '-m', 'add link');
    const headSha = repository.git('rev-parse', 'HEAD');
    const temp = await temporaryRoot();

    await expect(
      withProofWorkspaces(
        {
          repositoryRoot: repository.root,
          baseSha,
          headSha,
          limits,
          temporaryRoot: temp,
        },
        async () => undefined,
      ),
    ).rejects.toThrow('do not permit links');
    await expect(readdir(temp)).resolves.toEqual([]);
  });

  it('enforces file and byte limits before running an operation', async () => {
    const repository = await fixture();
    await repository.write('one.txt', '1');
    const baseSha = await repository.commitAll('base');
    await repository.write('two.txt', '22');
    const headSha = await repository.commitAll('head');
    const temp = await temporaryRoot();

    await expect(
      withProofWorkspaces(
        {
          repositoryRoot: repository.root,
          baseSha,
          headSha,
          limits: { maxFiles: 1, maxBytes: 10 },
          temporaryRoot: temp,
        },
        async () => undefined,
      ),
    ).rejects.toThrow('file limit');
    await expect(
      withProofWorkspaces(
        {
          repositoryRoot: repository.root,
          baseSha,
          headSha,
          limits: { maxFiles: 10, maxBytes: 1 },
          temporaryRoot: temp,
        },
        async () => undefined,
      ),
    ).rejects.toThrow('byte limit');
    await expect(readdir(temp)).resolves.toEqual([]);
  });

  it('does not create output for a cancelled request', async () => {
    const repository = await fixture();
    await repository.write('value.txt', 'base\n');
    const baseSha = await repository.commitAll('base');
    await repository.write('value.txt', 'head\n');
    const headSha = await repository.commitAll('head');
    const temp = await temporaryRoot();
    const controller = new AbortController();
    controller.abort();

    await expect(
      withProofWorkspaces(
        {
          repositoryRoot: repository.root,
          baseSha,
          headSha,
          limits,
          temporaryRoot: temp,
          signal: controller.signal,
        },
        async () => undefined,
      ),
    ).rejects.toThrow('cancelled');
    await expect(readdir(temp)).resolves.toEqual([]);
  });

  it('cleans workspaces when cancellation arrives during an operation', async () => {
    const repository = await fixture();
    await repository.write('value.txt', 'base\n');
    const baseSha = await repository.commitAll('base');
    await repository.write('value.txt', 'head\n');
    const headSha = await repository.commitAll('head');
    const temp = await temporaryRoot();
    const controller = new AbortController();

    await expect(
      withProofWorkspaces(
        {
          repositoryRoot: repository.root,
          baseSha,
          headSha,
          limits,
          temporaryRoot: temp,
          signal: controller.signal,
        },
        async () => {
          controller.abort();
        },
      ),
    ).rejects.toThrow('cancelled');
    await expect(readdir(temp)).resolves.toEqual([]);
  });

  it('rejects equal revisions before creating output', async () => {
    const repository = await fixture();
    await repository.write('value.txt', 'base\n');
    const sha = await repository.commitAll('base');
    const temp = await temporaryRoot();

    await expect(
      withProofWorkspaces(
        {
          repositoryRoot: repository.root,
          baseSha: sha,
          headSha: sha,
          limits,
          temporaryRoot: temp,
        },
        async () => undefined,
      ),
    ).rejects.toThrow('must differ');
    await expect(readdir(temp)).resolves.toEqual([]);
  });
});
