import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import type { CommandSpec } from '@walkz/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { executeCommand, truncateAndRedactOutput } from '../src/index.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = (name: string): string =>
  fileURLToPath(new URL('./fixtures/' + name, import.meta.url));
const trackedPids = new Set<number>();

function command(
  script: string,
  overrides: Partial<CommandSpec> = {},
): CommandSpec {
  return {
    executable: process.execPath,
    args: [fixture(script)],
    repositoryRoot,
    timeoutMs: 3_000,
    maxOutputBytesPerStream: 8_192,
    ...overrides,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

function forceKill(pid: number): void {
  if (!isProcessAlive(pid)) {
    return;
  }

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    spawnSync(systemRoot + '\\System32\\taskkill.exe', [
      '/pid',
      String(pid),
      '/T',
      '/F',
    ]);
    return;
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The process exited between the liveness check and the signal.
  }
}

afterEach(() => {
  for (const pid of trackedPids) {
    forceKill(pid);
  }
  trackedPids.clear();
});

describe('executeCommand', () => {
  it('passes hostile arguments literally without a shell', async () => {
    const hostileArguments = [
      '',
      'plain value',
      '& echo injected',
      '| node --version',
      '$(touch should-not-exist)',
      '%PATH%',
      '"quoted"',
    ];
    const result = await executeCommand(
      command('argv.mjs', {
        args: [fixture('argv.mjs'), ...hostileArguments],
        cwd: 'packages/sandbox/test/fixtures/path with spaces',
      }),
    );

    expect(result.outcome).toBe('succeeded');
    expect(JSON.parse(result.stdout.text)).toMatchObject({
      args: hostileArguments,
    });
    expect(JSON.parse(result.stdout.text).cwd).toContain('path with spaces');
  });

  it('strips sensitive variables and inherits only requested safe values', async () => {
    const result = await executeCommand(
      command('environment.mjs', {
        inheritEnvironment: ['SAFE_VALUE'],
      }),
      {
        parentEnvironment: {
          PATH: process.env.PATH,
          PATHEXT: process.env.PATHEXT,
          SystemRoot: process.env.SystemRoot,
          GROQ_API_KEY: 'gsk_test_secret_123',
          GITHUB_TOKEN: 'github_test_token_123',
          SAFE_VALUE: 'visible',
        },
      },
    );

    expect(result.outcome).toBe('succeeded');
    expect(JSON.parse(result.stdout.text)).toEqual({
      groqKey: null,
      githubToken: null,
      safeValue: 'visible',
    });
  });

  it('rejects secret aliases and loader-control variables', async () => {
    const secretAlias = await executeCommand(
      command('environment.mjs', {
        environment: {
          SAFE_VALUE: 'gsk_test_secret_123',
        },
      }),
      {
        parentEnvironment: {
          PATH: process.env.PATH,
          PATHEXT: process.env.PATHEXT,
          SystemRoot: process.env.SystemRoot,
          GROQ_API_KEY: 'gsk_test_secret_123',
        },
      },
    );
    const loaderVariable = await executeCommand(
      command('environment.mjs', {
        environment: {
          NODE_OPTIONS: '--require=untrusted-module',
        },
      }),
    );
    const pathOverride = await executeCommand(
      command('environment.mjs', {
        environment: {
          PATH: repositoryRoot,
        },
      }),
    );

    expect(secretAlias.outcome).toBe('configuration_error');
    expect(secretAlias.errorMessage).not.toContain('gsk_test_secret_123');
    expect(loaderVariable.outcome).toBe('configuration_error');
    expect(loaderVariable.errorMessage).toContain('alter command execution');
    expect(pathOverride.outcome).toBe('configuration_error');
    expect(pathOverride.errorMessage).toContain('alter command execution');
  });

  it('rejects a known secret in command arguments', async () => {
    const result = await executeCommand(
      command('argv.mjs', {
        args: [fixture('argv.mjs'), '--token=gsk_test_secret_123'],
      }),
      {
        parentEnvironment: {
          PATH: process.env.PATH,
          PATHEXT: process.env.PATHEXT,
          SystemRoot: process.env.SystemRoot,
          GROQ_API_KEY: 'gsk_test_secret_123',
        },
      },
    );

    expect(result.outcome).toBe('configuration_error');
    expect(result.errorMessage).not.toContain('gsk_test_secret_123');
  });

  it('bounds and redacts both output streams', async () => {
    const result = await executeCommand(command('noisy.mjs', {
      maxOutputBytesPerStream: 96,
    }), {
      parentEnvironment: {
        PATH: process.env.PATH,
        PATHEXT: process.env.PATHEXT,
        SystemRoot: process.env.SystemRoot,
        GROQ_API_KEY: 'gsk_test_secret_123',
      },
    });

    expect(result.outcome).toBe('succeeded');
    expect(result.stdout.redacted).toBe(true);
    expect(result.stderr.redacted).toBe(true);
    expect(result.stdout.truncated).toBe(true);
    expect(result.stderr.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout.text)).toBeLessThanOrEqual(96);
    expect(Buffer.byteLength(result.stderr.text)).toBeLessThanOrEqual(96);
    expect(result.stdout.text).not.toContain('gsk_test_secret_123');
    expect(result.stderr.text).not.toContain('gsk_test_secret_123');
  });

  it('reports cancellation', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100).unref();

    const result = await executeCommand(command('sleep.mjs'), {
      signal: controller.signal,
    });

    expect(result.outcome).toBe('cancelled');
    expect(result.termination.requested).toBe('cancelled');
  });

  it('does not spawn when cancellation was already requested', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executeCommand(
      command('argv.mjs', {
        executable: 'walkz-command-that-does-not-exist',
      }),
      {
        signal: controller.signal,
      },
    );

    expect(result.outcome).toBe('cancelled');
    expect(result.termination.accepted).toBe(false);
  });

  it('terminates descendants after a timeout', async () => {
    const result = await executeCommand(
      command('tree-parent.mjs', {
        timeoutMs: 800,
      }),
    );
    const processRecords = result.stdout.text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { role: string; pid: number });
    const descendants = processRecords.filter(
      ({ role }) => role === 'child' || role === 'grandchild',
    );

    expect(result.outcome).toBe('timed_out');
    expect(result.termination.requested).toBe('timeout');
    expect(descendants).toHaveLength(2);

    for (const { pid } of descendants) {
      trackedPids.add(pid);
      expect(await waitForProcessExit(pid)).toBe(true);
      trackedPids.delete(pid);
    }
  });

  it('rejects a working directory outside the repository', async () => {
    const result = await executeCommand(
      command('argv.mjs', {
        cwd: '..',
      }),
    );

    expect(result.outcome).toBe('configuration_error');
    expect(result.errorMessage).toContain('inside the repository');
  });

  it('reports an executable that cannot be spawned', async () => {
    const result = await executeCommand(
      command('argv.mjs', {
        executable: 'walkz-command-that-does-not-exist',
        args: [],
      }),
    );

    expect(result.outcome).toBe('spawn_error');
    expect(result.exitCode).toBeNull();
  });
});

describe('truncateAndRedactOutput', () => {
  it('does not split a UTF-8 character at the byte boundary', () => {
    const result = truncateAndRedactOutput('\u{1F642}'.repeat(20), {
      maxBytes: 31,
    });

    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('\uFFFD');
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(31);
  });

  it('redacts known and assignment-shaped secrets before truncating', () => {
    const result = truncateAndRedactOutput(
      'token-value GROQ_API_KEY=another-value',
      {
        maxBytes: 1_000,
        secrets: ['token-value'],
      },
    );

    expect(result.text).toBe('[REDACTED] GROQ_API_KEY=[REDACTED]');
    expect(result.redacted).toBe(true);
  });
});
