import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  withHostedGitHubCheckout,
  type HostedGitRunner,
} from '../src/index.js';

const roots: string[] = [];
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const githubToken = 'installation-token-value';

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'walkz-hosted-checkout-test-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

function fakeGit(): HostedGitRunner {
  return vi.fn(async (_root, args) => {
    const reference = args.at(-1);
    if (reference === 'refs/walkz/base^{commit}') return baseSha + '\n';
    if (reference === 'refs/walkz/head^{commit}') return headSha + '\n';
    return '';
  });
}

describe('hosted GitHub checkout', () => {
  it('fetches exact revisions without placing credentials in arguments', async () => {
    const root = await temporaryRoot();
    const runGit = fakeGit();

    await expect(withHostedGitHubCheckout({
      owner: 'walkz-owner',
      repository: 'private.repo',
      baseSha,
      headSha,
      githubToken,
    }, async (repositoryRoot) => repositoryRoot, {
      runGit,
      temporaryRoot: root,
    })).resolves.toContain('walkz-review-');

    const calls = vi.mocked(runGit).mock.calls;
    const fetchCall = calls.find(([, args]) => args[0] === 'fetch');
    expect(fetchCall?.[1]).toContain(`+${baseSha}:refs/walkz/base`);
    expect(fetchCall?.[1]).toContain(`+${headSha}:refs/walkz/head`);
    expect(fetchCall?.[2]).toMatchObject({ githubToken, timeoutMs: 120_000 });
    const authenticatedCommands = calls.filter(([, args]) =>
      args[0] === 'fetch' ||
      args[0] === 'rev-parse' ||
      args[0] === 'checkout'
    );
    expect(authenticatedCommands).toHaveLength(4);
    expect(authenticatedCommands.every(([, , options]) =>
      options?.githubToken === githubToken
    )).toBe(true);
    expect(calls.flatMap(([, args]) => args)).not.toContain(githubToken);
    expect(calls.find(([, args]) => args[0] === 'remote')?.[1]).toContain(
      'https://github.com/walkz-owner/private.repo.git',
    );
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('rejects a moved revision and removes the partial checkout', async () => {
    const root = await temporaryRoot();
    const runGit = vi.fn(async (_repositoryRoot, args: readonly string[]) => {
      if (args.at(-1) === 'refs/walkz/base^{commit}') return 'c'.repeat(40) + '\n';
      return '';
    });

    await expect(withHostedGitHubCheckout({
      owner: 'owner',
      repository: 'repo',
      baseSha,
      headSha,
      githubToken,
    }, async () => undefined, {
      runGit,
      temporaryRoot: root,
    })).rejects.toThrow('does not match the durable review run');
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('rejects unsafe repository coordinates before creating files', async () => {
    const root = await temporaryRoot();

    await expect(withHostedGitHubCheckout({
      owner: '../owner',
      repository: 'repo',
      baseSha,
      headSha,
      githubToken,
    }, async () => undefined, { temporaryRoot: root })).rejects.toThrow();
    await expect(readdir(root)).resolves.toEqual([]);
  });
});
