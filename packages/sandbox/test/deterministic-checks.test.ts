import type {
  CommandExecutionResult,
  CommandOutcome,
  RepositoryConfig,
} from '@walkz/contracts';
import { createDefaultWalkzConfig } from '@walkz/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  requestCommandApproval,
  runDeterministicChecks,
} from '../src/index.js';

function config(
  policy: RepositoryConfig['commandApprovalPolicy'] = 'prompt',
  required = true,
): RepositoryConfig {
  return {
    ...createDefaultWalkzConfig([
      {
        id: 'test',
        executable: 'node',
        args: ['test.mjs'],
        cwd: '.',
        required,
      },
    ]),
    commandApprovalPolicy: policy,
  };
}

function execution(outcome: CommandOutcome): CommandExecutionResult {
  return {
    outcome,
    exitCode:
      outcome === 'succeeded' ? 0 : outcome === 'failed' ? 1 : null,
    signal: null,
    durationMs: 5,
    stdout: {
      text: '',
      originalBytes: 0,
      truncated: false,
      redacted: false,
    },
    stderr: {
      text: '',
      originalBytes: 0,
      truncated: false,
      redacted: false,
    },
    termination: {
      requested:
        outcome === 'timed_out'
          ? 'timeout'
          : outcome === 'cancelled'
            ? 'cancelled'
            : null,
      accepted: outcome === 'timed_out' || outcome === 'cancelled',
      guarantee: 'best_effort',
    },
  };
}

describe('requestCommandApproval', () => {
  it('needs no approval when no commands are configured', async () => {
    await expect(
      requestCommandApproval(createDefaultWalkzConfig()),
    ).resolves.toEqual({ status: 'not_required', source: 'none' });
  });

  it('honors commands approved through trusted configuration', async () => {
    const requester = vi.fn();

    await expect(
      requestCommandApproval(config('trusted_config'), requester),
    ).resolves.toEqual({
      status: 'approved',
      source: 'trusted_config',
    });
    expect(requester).not.toHaveBeenCalled();
  });

  it('does not run prompt-gated commands without a requester', async () => {
    await expect(requestCommandApproval(config())).resolves.toEqual({
      status: 'unavailable',
      source: 'none',
    });
  });

  it('records the user decision', async () => {
    await expect(
      requestCommandApproval(config(), async () => false),
    ).resolves.toEqual({ status: 'declined', source: 'user' });
  });
});

describe('runDeterministicChecks', () => {
  it('returns a complete empty run when there are no commands', async () => {
    await expect(
      runDeterministicChecks(createDefaultWalkzConfig(), 'C:\\repo'),
    ).resolves.toEqual({
      approval: { status: 'not_required', source: 'none' },
      plannedCount: 0,
      checks: [],
      status: 'complete',
    });
  });

  it('does not execute a required command when approval is unavailable', async () => {
    const executor = vi.fn();

    const result = await runDeterministicChecks(config(), 'C:\\repo', {
      executor,
    });

    expect(result.status).toBe('incomplete');
    expect(result.approval.status).toBe('unavailable');
    expect(executor).not.toHaveBeenCalled();
  });

  it('runs approved commands as argument arrays in configured order', async () => {
    const twoCommands = {
      ...config('trusted_config'),
      commands: [
        ...config('trusted_config').commands,
        {
          id: 'build',
          executable: 'node',
          args: ['build.mjs'],
          cwd: '.',
          required: true,
        },
      ],
    };
    const executor = vi.fn().mockResolvedValue(execution('succeeded'));

    const result = await runDeterministicChecks(
      twoCommands,
      'C:\\repo with spaces',
      { executor },
    );

    expect(result.status).toBe('complete');
    expect(result.checks.map((check) => check.commandId)).toEqual([
      'test',
      'build',
    ]);
    expect(executor.mock.calls[0]?.[0]).toMatchObject({
      executable: 'node',
      args: ['test.mjs'],
      repositoryRoot: 'C:\\repo with spaces',
    });
  });

  it('treats a nonzero required check as completed evidence', async () => {
    const result = await runDeterministicChecks(
      config('trusted_config'),
      'C:\\repo',
      { executor: async () => execution('failed') },
    );

    expect(result.status).toBe('complete');
    expect(result.checks[0]?.execution.exitCode).toBe(1);
  });

  it.each(['spawn_error', 'configuration_error'] as const)(
    'reports %s as an execution error',
    async (outcome) => {
      const result = await runDeterministicChecks(
        config('trusted_config'),
        'C:\\repo',
        { executor: async () => execution(outcome) },
      );

      expect(result.status).toBe('error');
    },
  );

  it.each(['timed_out', 'cancelled'] as const)(
    'reports %s as incomplete',
    async (outcome) => {
      const result = await runDeterministicChecks(
        config('trusted_config'),
        'C:\\repo',
        { executor: async () => execution(outcome) },
      );

      expect(result.status).toBe('incomplete');
    },
  );

  it('allows skipped optional commands without claiming they ran', async () => {
    const result = await runDeterministicChecks(
      config('prompt', false),
      'C:\\repo',
    );

    expect(result.status).toBe('complete');
    expect(result.approval.status).toBe('unavailable');
    expect(result.checks).toEqual([]);
  });
});
