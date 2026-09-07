import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMockProvider } from '@walkz/providers';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/index.js';

const goldenRoot = fileURLToPath(
  new URL('../../../tests/golden/', import.meta.url),
);
const temporaryDirectories = new Set<string>();

function git(repository: string, ...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Git command failed.');
  }
}

async function createGoldenRepository(
  fixture: 'clean' | 'broken',
): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'walkz golden '));
  temporaryDirectories.add(repository);
  await mkdir(join(repository, 'src'));
  await Promise.all([
    cp(
      join(goldenRoot, fixture, 'base', 'walkz.config.json'),
      join(repository, 'walkz.config.json'),
    ),
    cp(
      join(goldenRoot, fixture, 'base', 'check.mjs'),
      join(repository, 'check.mjs'),
    ),
    cp(
      join(goldenRoot, fixture, 'base', 'src', 'value.mjs'),
      join(repository, 'src', 'value.mjs'),
    ),
  ]);
  git(repository, 'init', '--quiet', '-b', 'main');
  git(repository, 'config', 'user.name', 'Walkz Demo');
  git(repository, 'config', 'user.email', 'walkz@example.test');
  git(repository, 'add', '--all');
  git(repository, 'commit', '--quiet', '-m', 'base');
  git(repository, 'checkout', '--quiet', '-b', 'feature');
  await writeFile(
    join(repository, 'src', 'value.mjs'),
    await readFile(
      join(goldenRoot, fixture, 'head', 'src', 'value.mjs'),
      'utf8',
    ),
    'utf8',
  );
  git(repository, 'add', '--all');
  git(repository, 'commit', '--quiet', '-m', 'change value');
  return repository;
}

async function reviewFixture(
  fixture: 'clean' | 'broken',
): Promise<{
  exitCode: number;
  output: Record<string, unknown>;
  durationMs: number;
}> {
  const repository = await createGoldenRepository(fixture);
  const stdout: string[] = [];
  const startedAt = performance.now();
  const review =
    fixture === 'clean'
      ? { findings: [] }
      : {
          findings: [
            {
              category: 'correctness',
              severity: 'high',
              file: 'src/value.mjs',
              line: 1,
              claim: 'Zero crosses the wrong boundary.',
              failureMechanism: 'The strict comparison returns one for zero.',
              suggestedProof: 'Run the configured boundary check.',
              confidence: 0.98,
            },
          ],
        };
  const exitCode = await runCli(['review', '--json'], {
    cwd: repository,
    provider: createMockProvider({
      outcomes: [{ type: 'review', review }],
    }),
    io: {
      stdout: (message) => stdout.push(message),
      stderr: () => {},
    },
  });
  return {
    exitCode,
    output: JSON.parse(stdout.join('')) as Record<string, unknown>,
    durationMs: performance.now() - startedAt,
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

describe('golden local review', () => {
  it('returns SHIP for the clean fixture', async () => {
    const result = await reviewFixture('clean');

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      verdict: 'SHIP',
      findings: [],
      deterministicChecks: {
        status: 'complete',
        checks: [
          {
            commandId: 'test',
            execution: { outcome: 'succeeded', exitCode: 0 },
          },
        ],
      },
    });
    expect(result.durationMs).toBeLessThan(60_000);
  });

  it('returns FIX with supported evidence for the broken fixture', async () => {
    const result = await reviewFixture('broken');

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatchObject({
      verdict: 'FIX',
      findings: [
        {
          file: 'src/value.mjs',
          line: 1,
          evidenceLevel: 'SUPPORTED',
          lifecycleStatus: 'supported',
          evidence: [
            {
              kind: 'deterministic_check',
              headOutcome: 'failed',
              headExitCode: 1,
            },
          ],
        },
      ],
    });
    expect(result.durationMs).toBeLessThan(60_000);
  });
});
