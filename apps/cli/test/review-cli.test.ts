import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultWalkzConfig } from '@walkz/contracts';
import { createMockProvider } from '@walkz/providers';
import { afterEach, describe, expect, it } from 'vitest';

import {
  runCli,
  writeWalkzConfig,
} from '../src/index.js';

const temporaryDirectories = new Set<string>();

interface CapturedIo {
  stdout: string[];
  stderr: string[];
  io: {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
  };
}

function captureIo(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
  };
}

function git(repository: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'Git command failed.');
  }
  return result.stdout;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'walkz review cli '));
  temporaryDirectories.add(root);
  git(root, 'init', '--quiet', '-b', 'main');
  git(root, 'config', 'user.name', 'Walkz Test');
  git(root, 'config', 'user.email', 'walkz@example.test');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'value.ts'), 'export const value = 1;\n');
  await writeWalkzConfig(root, createDefaultWalkzConfig());
  git(root, 'add', '--all');
  git(root, 'commit', '--quiet', '-m', 'base');
  return root;
}

function finding(line = 1) {
  return {
    category: 'correctness',
    severity: 'high',
    file: 'src/value.ts',
    line,
    claim: 'The new value breaks the boundary.',
    failureMechanism: 'The caller receives the wrong result.',
    suggestedProof: 'Run the boundary test.',
    confidence: 0.9,
  };
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('walkz review', () => {
  it('reviews staged changes without a model and emits JSON', async () => {
    const root = await repository();
    await writeFile(join(root, 'src', 'value.ts'), 'export const value = 2;\n');
    git(root, 'add', 'src/value.ts');
    const captured = captureIo();

    const exitCode = await runCli(
      ['review', '--staged', '--no-model', '--json'],
      { cwd: root, io: captured.io },
    );
    const output = JSON.parse(captured.stdout.join(''));

    expect(exitCode).toBe(0);
    expect(output).toMatchObject({
      verdict: 'SHIP',
      headSha: null,
      headRef: 'INDEX',
      findings: [],
      provider: { status: 'not_requested' },
    });
    expect(captured.stderr).toEqual([]);
  });

  it('reviews a branch with a mock provider', async () => {
    const root = await repository();
    git(root, 'checkout', '--quiet', '-b', 'feature');
    await writeFile(join(root, 'src', 'value.ts'), 'export const value = 2;\n');
    git(root, 'add', '--all');
    git(root, 'commit', '--quiet', '-m', 'change value');
    const captured = captureIo();

    const exitCode = await runCli(['review'], {
      cwd: root,
      io: captured.io,
      provider: createMockProvider({
        outcomes: [{ type: 'review', review: { findings: [finding()] } }],
      }),
    });

    expect(exitCode).toBe(0);
    expect(captured.stdout.join('')).toContain('Verdict: SHIP');
    expect(captured.stdout.join('')).toContain(
      '[UNVERIFIED] high src/value.ts:1',
    );
    expect(captured.stderr.join('')).toContain('Provider privacy:');
    expect(captured.stderr.join('')).toContain('sends no data over the network');
  });

  it('returns INCONCLUSIVE for malformed provider output', async () => {
    const root = await repository();
    git(root, 'checkout', '--quiet', '-b', 'feature');
    await writeFile(join(root, 'src', 'value.ts'), 'export const value = 2;\n');
    git(root, 'add', '--all');
    git(root, 'commit', '--quiet', '-m', 'change value');
    const captured = captureIo();

    const exitCode = await runCli(['review', '--json'], {
      cwd: root,
      io: captured.io,
      provider: createMockProvider({
        outcomes: [{ type: 'review', review: { findings: [{ broken: true }] } }],
      }),
    });
    const output = JSON.parse(captured.stdout.join(''));

    expect(exitCode).toBe(2);
    expect(output).toMatchObject({
      verdict: 'INCONCLUSIVE',
      provider: {
        status: 'incomplete',
        failureCode: 'invalid_response',
      },
    });
  });

  it('runs prompt-gated commands only after explicit approval', async () => {
    const root = await repository();
    const configured = createDefaultWalkzConfig([
      {
        id: 'test',
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: '.',
        required: true,
      },
    ]);
    await writeFile(
      join(root, 'walkz.config.json'),
      JSON.stringify(configured),
    );
    git(root, 'add', 'walkz.config.json');
    git(root, 'commit', '--quiet', '-m', 'configure checks');
    await writeFile(join(root, 'src', 'value.ts'), 'export const value = 2;\n');
    git(root, 'add', 'src/value.ts');
    const captured = captureIo();
    let approvalCount = 0;

    const exitCode = await runCli(
      ['review', '--staged', '--no-model'],
      {
        cwd: root,
        io: captured.io,
        requestCommandApproval: async (commands) => {
          approvalCount += 1;
          expect(commands.map((command) => command.id)).toEqual(['test']);
          return true;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(approvalCount).toBe(1);
    expect(captured.stdout.join('')).toContain('PASS      test');
  });

  it('does not let a branch grant itself command authority', async () => {
    const root = await repository();
    git(root, 'checkout', '--quiet', '-b', 'feature');
    const changedConfig = createDefaultWalkzConfig([
      {
        id: 'branch-command',
        executable: process.execPath,
        args: ['-e', 'process.exit(9)'],
        cwd: '.',
        required: true,
      },
    ]);
    await writeFile(
      join(root, 'walkz.config.json'),
      JSON.stringify(changedConfig),
    );
    await writeFile(join(root, 'src', 'value.ts'), 'export const value = 2;\n');
    git(root, 'add', '--all');
    git(root, 'commit', '--quiet', '-m', 'try changing review authority');
    const captured = captureIo();
    let approvalRequested = false;

    const exitCode = await runCli(['review', '--no-model'], {
      cwd: root,
      io: captured.io,
      requestCommandApproval: async () => {
        approvalRequested = true;
        return true;
      },
    });

    expect(exitCode).toBe(0);
    expect(approvalRequested).toBe(false);
    expect(captured.stdout.join('')).toContain('Checks:\n  none');
  });

  it('rejects review flags on other commands', async () => {
    const captured = captureIo();

    expect(
      await runCli(['doctor', '--json'], { io: captured.io }),
    ).toBe(3);
    expect(captured.stderr.join('')).toContain(
      'Review options can only be used with "walkz review".',
    );
  });
});
