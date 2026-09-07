import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CapturedOutput,
  CommandExecutionResult,
  CommandSpec,
  ProofPlan,
} from '@walkz/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  executeProofInContainer,
  executeProofPair,
  type DockerCommandExecutor,
} from '../src/index.js';

const roots: string[] = [];
const SHA256 = 'a'.repeat(64);
const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const FIXED_TIME = new Date('2026-09-07T16:00:00.000Z');

function output(text = ''): CapturedOutput {
  return {
    text,
    originalBytes: Buffer.byteLength(text),
    truncated: false,
    redacted: false,
  };
}

function execution(
  outcome: CommandExecutionResult['outcome'] = 'succeeded',
  exitCode: number | null = 0,
): CommandExecutionResult {
  return {
    outcome,
    exitCode,
    signal: null,
    durationMs: 25,
    stdout: output('proof output\n'),
    stderr: output(),
    termination: {
      requested: null,
      accepted: false,
      guarantee: 'best_effort',
    },
  };
}

function emptyExecution(): CommandExecutionResult {
  return {
    ...execution(),
    stdout: output(),
  };
}

function isCleanupVerification(spec: CommandSpec): boolean {
  return spec.args[0] === 'container' && spec.args[1] === 'ls';
}

function plan(): ProofPlan {
  const content = Buffer.from('process.exit(0);\n');
  return {
    schemaVersion: 1,
    runId: 'run-1',
    findingFingerprint: SHA256,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    containerImage: 'node:24-alpine@sha256:' + '3'.repeat(64),
    isolation: {
      network: 'none',
      readOnlyRootFilesystem: true,
      dropCapabilities: 'all',
      noNewPrivileges: true,
    },
    command: {
      executable: 'node',
      args: ['.walkz-proof/reproducer.mjs'],
      cwd: '.',
    },
    commandDigest: '4'.repeat(64),
    files: [
      {
        path: '.walkz-proof/reproducer.mjs',
        contentBase64: content.toString('base64'),
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    ],
    limits: {
      timeoutMs: 10_000,
      maxOutputBytesPerStream: 16_384,
      memoryBytes: 256 * 1_024 * 1_024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 64,
      maxWritableBytes: 16 * 1_024 * 1_024,
    },
  };
}

async function workspace(revision: 'base' | 'head') {
  const root = await mkdtemp(join(tmpdir(), 'walkz docker proof '));
  roots.push(root);
  return {
    revision,
    sha: revision === 'base' ? BASE_SHA : HEAD_SHA,
    path: root,
  } as const;
}

afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.length = 0;
});

describe('executeProofInContainer', () => {
  it('builds a locked argument-array invocation and removes its inputs', async () => {
    const target = await workspace('base');
    const calls: CommandSpec[] = [];
    const parentEnvironment = {
      PATH: process.env.PATH,
      GROQ_API_KEY: 'must-not-reach-container',
    };
    const executor: DockerCommandExecutor = async (spec) => {
      calls.push(spec);
      if (spec.args[0] === 'run') {
        await expect(
          readFile(join(target.path, '.walkz-proof', 'reproducer.mjs'), 'utf8'),
        ).resolves.toBe('process.exit(0);\n');
      }
      return isCleanupVerification(spec) ? emptyExecution() : execution();
    };

    const result = await executeProofInContainer(plan(), SHA256, target, {
      executor,
      parentEnvironment,
      containerNameFactory: () => 'walkz-proof-base-fixed',
      containerUser: '1000:1000',
      now: () => FIXED_TIME,
    });

    expect(result).toMatchObject({
      outcome: 'passed',
      revision: 'base',
      sha: BASE_SHA,
      exitCode: 0,
      recordedAt: FIXED_TIME.toISOString(),
    });
    expect(result.artifacts).toHaveLength(1);
    expect(calls).toHaveLength(3);
    const run = calls[0]!;
    expect(run.executable).toBe('docker');
    expect(run.args).toEqual(
      expect.arrayContaining([
        '--pull',
        'never',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges=true',
        '--ipc',
        'none',
        '--pids-limit',
        '64',
        '--memory',
        String(256 * 1_024 * 1_024),
        '--memory-swap',
        String(256 * 1_024 * 1_024),
        '--cpus',
        '1.000000000',
        '--user',
        '1000:1000',
        '--log-driver',
        'none',
        '--entrypoint',
        'node',
        'NODE_OPTIONS=',
      ]),
    );
    expect(run.args.slice(-2)).toEqual([
      plan().containerImage,
      '.walkz-proof/reproducer.mjs',
    ]);
    expect(JSON.stringify(run.args)).not.toContain('must-not-reach-container');
    expect(calls[1]!.args).toEqual([
      'container',
      'rm',
      '--force',
      '--volumes',
      'walkz-proof-base-fixed',
    ]);
    expect(calls[2]!.args).toEqual([
      'container',
      'ls',
      '--all',
      '--quiet',
      '--filter',
      'name=^/walkz-proof-base-fixed$',
    ]);
    await expect(readdir(target.path)).resolves.toEqual([]);
  });

  it.each([
    ['timed_out', null, 'timed_out'],
    ['cancelled', null, 'cancelled'],
    ['failed', 1, 'failed'],
    ['failed', 125, 'infrastructure_error'],
    ['spawn_error', null, 'infrastructure_error'],
  ] as const)(
    'maps %s execution to %s proof evidence',
    async (commandOutcome, exitCode, proofOutcome) => {
      const target = await workspace('head');
      const executor: DockerCommandExecutor = async (spec) =>
        spec.args[0] === 'run'
          ? execution(commandOutcome, exitCode)
          : emptyExecution();

      const result = await executeProofInContainer(plan(), SHA256, target, {
        executor,
        containerNameFactory: () => 'walkz-proof-head-fixed',
        containerUser: '1000:1000',
        now: () => FIXED_TIME,
      });

      expect(result.outcome).toBe(proofOutcome);
      await expect(readdir(target.path)).resolves.toEqual([]);
    },
  );

  it('turns cleanup failure into an infrastructure error', async () => {
    const target = await workspace('base');
    const executor: DockerCommandExecutor = async (spec) => {
      if (spec.args[0] === 'run') {
        return execution();
      }
      if (isCleanupVerification(spec)) {
        return { ...emptyExecution(), stdout: output('container-id\n') };
      }
      return execution('failed', 1);
    };

    const result = await executeProofInContainer(plan(), SHA256, target, {
      executor,
      containerNameFactory: () => 'walkz-proof-base-fixed',
      containerUser: '1000:1000',
      now: () => FIXED_TIME,
    });

    expect(result.outcome).toBe('infrastructure_error');
    expect(result.stderr.summary).toContain('cleanup could not be verified');
    await expect(readdir(target.path)).resolves.toEqual([]);
  });

  it('bounds evidence summaries below the execution capture limit', async () => {
    const target = await workspace('base');
    const executor: DockerCommandExecutor = async (spec) =>
      spec.args[0] === 'run'
        ? { ...execution(), stdout: output('x'.repeat(20_000)) }
        : emptyExecution();

    const result = await executeProofInContainer(plan(), SHA256, target, {
      executor,
      containerNameFactory: () => 'walkz-proof-base-fixed',
      containerUser: '1000:1000',
      now: () => FIXED_TIME,
    });

    expect(Buffer.byteLength(result.stdout.summary)).toBeLessThanOrEqual(8_192);
    expect(result.stdout.originalBytes).toBe(20_000);
    expect(result.stdout.truncated).toBe(true);
  });

  it('does not start Docker when cancellation already happened', async () => {
    const target = await workspace('base');
    const controller = new AbortController();
    controller.abort();
    const executor: DockerCommandExecutor = async () => {
      throw new Error('executor must not run');
    };

    const result = await executeProofInContainer(plan(), SHA256, target, {
      executor,
      signal: controller.signal,
      now: () => FIXED_TIME,
    });

    expect(result.outcome).toBe('cancelled');
    await expect(readdir(target.path)).resolves.toEqual([]);
  });

  it('rejects a workspace bound to the wrong commit', async () => {
    const target = await workspace('base');
    await expect(
      executeProofInContainer(plan(), SHA256, {
        ...target,
        sha: HEAD_SHA,
      }),
    ).rejects.toThrow('does not match');
  });
});

describe('executeProofPair', () => {
  it('runs base and head with the same plan', async () => {
    const base = await workspace('base');
    const head = await workspace('head');
    const calls: CommandSpec[] = [];
    const executor: DockerCommandExecutor = async (spec) => {
      calls.push(spec);
      return isCleanupVerification(spec) ? emptyExecution() : execution();
    };

    const result = await executeProofPair(
      plan(),
      SHA256,
      { base, head },
      {
        executor,
        containerNameFactory: (revision) =>
          'walkz-proof-' + revision + '-fixed',
        containerUser: '1000:1000',
        now: () => FIXED_TIME,
      },
    );

    expect(result.base.revision).toBe('base');
    expect(result.head.revision).toBe('head');
    const runCalls = calls.filter((call) => call.args[0] === 'run');
    expect(runCalls).toHaveLength(2);
    const imageIndex = runCalls[0]!.args.indexOf(plan().containerImage);
    expect(imageIndex).toBeGreaterThan(0);
    expect(runCalls[1]!.args.slice(imageIndex)).toEqual(
      runCalls[0]!.args.slice(imageIndex),
    );
  });
});
