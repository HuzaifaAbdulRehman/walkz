import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDefaultWalkzConfig } from '@walkz/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadWalkzConfig,
  runCli,
  WALKZ_CONFIG_FILENAME,
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

function environmentWithGroqKey(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GROQ_API_KEY: 'gsk_test_secret_123',
  };
}

function environmentWithoutGroqKey(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.GROQ_API_KEY;
  return environment;
}

async function createRepository(options: {
  scripts?: Record<string, string>;
} = {}): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), 'walkz cli test '));
  temporaryDirectories.add(repository);
  const git = spawnSync('git', ['init', '--quiet'], {
    cwd: repository,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  if (git.status !== 0) {
    throw new Error(git.stderr || 'Could not initialize the test repository.');
  }

  if (options.scripts !== undefined) {
    await writeFile(
      join(repository, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: options.scripts,
      }),
    );
  }
  return repository;
}

async function initialize(repository: string): Promise<void> {
  const captured = captureIo();
  const exitCode = await runCli(['init'], {
    cwd: repository,
    environment: environmentWithGroqKey(),
    io: captured.io,
  });
  if (exitCode !== 0) {
    throw new Error(captured.stderr.join(''));
  }
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

describe('walkz init', () => {
  it('writes a valid minimal config with discovered commands', async () => {
    const repository = await createRepository({
      scripts: {
        build: 'tsc',
        custom: 'node custom.mjs',
        test: 'vitest',
      },
    });
    const captured = captureIo();

    const exitCode = await runCli(['init'], {
      cwd: repository,
      environment: environmentWithGroqKey(),
      io: captured.io,
    });
    const config = await loadWalkzConfig(repository);

    expect(exitCode).toBe(0);
    expect(config.commands.map((command) => command.id)).toEqual([
      'test',
      'build',
    ]);
    expect(config.premiumEnabled).toBe(false);
    expect(config.spendingLimitUsd).toBe(0);
    expect(config.policyPacks).toEqual([
      'security-core@1',
      'supply-chain@1',
      'delivery-safety@1',
    ]);
    expect(captured.stdout.join('')).toContain(
      '2 standard npm commands were added.',
    );
    expect(captured.stderr).toEqual([]);
  });

  it('never overwrites an existing config', async () => {
    const repository = await createRepository();
    await initialize(repository);
    const configPath = join(repository, WALKZ_CONFIG_FILENAME);
    const before = await readFile(configPath, 'utf8');
    const captured = captureIo();

    const exitCode = await runCli(['init'], {
      cwd: repository,
      environment: environmentWithGroqKey(),
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(captured.stderr.join('')).toContain('already exists');
    expect(captured.stderr.join('')).toContain('left it unchanged');
  });

  it('fails outside a Git repository without writing a config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'walkz no repo test '));
    temporaryDirectories.add(directory);
    const captured = captureIo();

    const exitCode = await runCli(['init'], {
      cwd: directory,
      environment: environmentWithGroqKey(),
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(captured.stderr.join('')).toContain('No Git repository');
    await expect(
      readFile(join(directory, WALKZ_CONFIG_FILENAME)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('walkz doctor', () => {
  it('passes a ready local setup without exposing the Groq key', async () => {
    const repository = await createRepository({
      scripts: {
        test: 'vitest',
      },
    });
    await initialize(repository);
    const captured = captureIo();
    const environment = environmentWithGroqKey();

    const exitCode = await runCli(['doctor'], {
      cwd: repository,
      environment,
      io: captured.io,
    });
    const output = captured.stdout.join('');

    expect(exitCode).toBe(0);
    expect(output).toContain('PASS Node:');
    expect(output).toContain('PASS Git:');
    expect(output).toContain('PASS Repository:');
    expect(output).toContain('PASS Config:');
    expect(output).toContain('PASS Commands:');
    expect(output).toContain('PASS Groq key: GROQ_API_KEY is set.');
    expect(output).not.toContain(environment.GROQ_API_KEY);
  });

  it('warns when the Groq key is absent', async () => {
    const repository = await createRepository({
      scripts: {
        test: 'vitest',
      },
    });
    await initialize(repository);
    const captured = captureIo();

    const exitCode = await runCli(['doctor'], {
      cwd: repository,
      environment: environmentWithoutGroqKey(),
      io: captured.io,
    });

    expect(exitCode).toBe(2);
    expect(captured.stdout.join('')).toContain(
      'WARN Groq key: GROQ_API_KEY is missing.',
    );
  });

  it('explains malformed configuration', async () => {
    const repository = await createRepository();
    await writeFile(join(repository, WALKZ_CONFIG_FILENAME), '{broken');
    const captured = captureIo();

    const exitCode = await runCli(['doctor'], {
      cwd: repository,
      environment: environmentWithGroqKey(),
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(captured.stdout.join('')).toContain(
      'FAIL Config: walkz.config.json is not valid JSON.',
    );
    expect(captured.stdout.join('')).toContain(
      'SKIP Commands: A valid repository config is required',
    );
  });

  it('rejects an oversized config before parsing it', async () => {
    const repository = await createRepository();
    await writeFile(
      join(repository, WALKZ_CONFIG_FILENAME),
      ' '.repeat(256 * 1_024 + 1),
    );
    const captured = captureIo();

    const exitCode = await runCli(['doctor'], {
      cwd: repository,
      environment: environmentWithGroqKey(),
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(captured.stdout.join('')).toContain(
      'FAIL Config: walkz.config.json exceeds the 256 KiB safety limit.',
    );
  });

  it('explains an unavailable configured executable', async () => {
    const repository = await createRepository();
    const config = createDefaultWalkzConfig([
      {
        id: 'test',
        executable: 'walkz-command-that-does-not-exist',
        args: [],
        cwd: '.',
        required: true,
      },
    ]);
    await writeFile(
      join(repository, WALKZ_CONFIG_FILENAME),
      JSON.stringify(config),
    );
    const captured = captureIo();

    const exitCode = await runCli(['doctor'], {
      cwd: repository,
      environment: environmentWithGroqKey(),
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(captured.stdout.join('')).toContain(
      'FAIL Commands: Command "test" is not ready.',
    );
    expect(captured.stdout.join('')).toContain('was not found');
  });

  it('rejects an old Node version', async () => {
    const repository = await createRepository();
    await initialize(repository);
    const captured = captureIo();

    const exitCode = await runCli(['doctor'], {
      cwd: repository,
      environment: environmentWithGroqKey(),
      io: captured.io,
      nodeVersion: '22.0.0',
    });

    expect(exitCode).toBe(3);
    expect(captured.stdout.join('')).toContain(
      'FAIL Node: 22.0.0 is unsupported.',
    );
  });

  it('reports missing Git from the supplied environment', async () => {
    const repository = await createRepository();
    await initialize(repository);
    const captured = captureIo();

    const exitCode = await runCli(['doctor'], {
      cwd: repository,
      environment: {
        GROQ_API_KEY: 'gsk_test_secret_123',
      },
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(captured.stdout.join('')).toContain('FAIL Git: Git could not be started.');
    expect(captured.stdout.join('')).toContain(
      'FAIL Repository: Git does not recognize this directory as a working tree.',
    );
  });

  it('warns when an optional command is unavailable', async () => {
    const repository = await createRepository();
    const config = createDefaultWalkzConfig([
      {
        id: 'optional-check',
        executable: 'walkz-command-that-does-not-exist',
        args: [],
        cwd: '.',
        required: false,
      },
    ]);
    await writeFile(
      join(repository, WALKZ_CONFIG_FILENAME),
      JSON.stringify(config),
    );
    const captured = captureIo();

    const exitCode = await runCli(['doctor'], {
      cwd: repository,
      environment: environmentWithGroqKey(),
      io: captured.io,
    });

    expect(exitCode).toBe(2);
    expect(captured.stdout.join('')).toContain(
      'WARN Commands: Optional command "optional-check" is unavailable.',
    );
    expect(captured.stdout.join('')).toContain(
      'Result: 5 passed, 1 warning, 0 failed.',
    );
  });

  it('fails an unsafe optional command', async () => {
    const repository = await createRepository();
    const config = createDefaultWalkzConfig([
      {
        id: 'optional-check',
        executable: process.execPath,
        args: ['--version'],
        cwd: '..',
        required: false,
      },
    ]);
    await writeFile(
      join(repository, WALKZ_CONFIG_FILENAME),
      JSON.stringify(config),
    );
    const captured = captureIo();

    const exitCode = await runCli(['doctor'], {
      cwd: repository,
      environment: environmentWithGroqKey(),
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    expect(captured.stdout.join('')).toContain(
      'FAIL Commands: Command "optional-check" is unsafe.',
    );
    expect(captured.stdout.join('')).toContain('must stay inside the repository');
  });
});

describe('CLI arguments', () => {
  it('prints help and rejects unknown commands', async () => {
    const help = captureIo();
    const unknown = captureIo();

    expect(await runCli(['--help'], { io: help.io })).toBe(0);
    expect(help.stdout.join('')).toContain('walkz doctor');
    expect(await runCli(['unknown'], { io: unknown.io })).toBe(3);
    expect(unknown.stderr.join('')).toContain('Unknown command "unknown"');
  });

  it('works from a nested directory with spaces', async () => {
    const repository = await createRepository();
    const nested = join(repository, 'folder with spaces');
    await mkdir(nested);
    const captured = captureIo();

    const exitCode = await runCli(['init'], {
      cwd: nested,
      environment: environmentWithGroqKey(),
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect((await loadWalkzConfig(repository)).schemaVersion).toBe(1);
  });
});
