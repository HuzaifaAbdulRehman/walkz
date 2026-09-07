import { describe, expect, it } from 'vitest';

import {
  parseProofExecutionResult,
  parseProofPlan,
} from '../src/index.js';

const SHA256 = 'a'.repeat(64);

function plan(): unknown {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    findingFingerprint: SHA256,
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    containerImage: 'node:24@sha256:' + '3'.repeat(64),
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
        contentBase64: 'ZXhwb3J0IHt9Ow==',
        sha256: '5'.repeat(64),
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

describe('proof plan contracts', () => {
  it('accepts an exact, bounded plan', () => {
    expect(parseProofPlan(plan())).toMatchObject({
      schemaVersion: 1,
      runId: 'run-1',
      baseSha: '1'.repeat(40),
      headSha: '2'.repeat(40),
    });
  });

  it.each([
    '/absolute/reproducer.mjs',
    '../outside.mjs',
    'nested/../outside.mjs',
    'windows\\outside.mjs',
  ])('rejects unsafe proof file path %s', (path) => {
    const input = plan() as ReturnType<typeof plan> & {
      files: Array<{ path: string }>;
    };
    input.files[0]!.path = path;

    expect(() => parseProofPlan(input)).toThrow();
  });

  it('rejects case-colliding proof files', () => {
    const input = plan() as ReturnType<typeof plan> & {
      files: Array<Record<string, unknown>>;
    };
    input.files.push({
      ...input.files[0],
      path: '.WALKZ-PROOF/reproducer.mjs',
    });

    expect(() => parseProofPlan(input)).toThrow(
      'unique across platforms',
    );
  });

  it('requires different exact base and head revisions', () => {
    const input = plan() as Record<string, unknown>;
    input.headSha = input.baseSha;

    expect(() => parseProofPlan(input)).toThrow(
      'Base and head revisions must differ',
    );
  });

  it('requires a digest-pinned container image', () => {
    const input = plan() as Record<string, unknown>;
    input.containerImage = 'node:24';

    expect(() => parseProofPlan(input)).toThrow();
  });

  it('does not permit weaker isolation settings', () => {
    const input = plan() as ReturnType<typeof plan> & {
      isolation: { network: string };
    };
    input.isolation.network = 'bridge';

    expect(() => parseProofPlan(input)).toThrow();
  });

  it('caps every resource dimension', () => {
    const input = plan() as ReturnType<typeof plan> & {
      limits: { pidsLimit: number };
    };
    input.limits.pidsLimit = 10_000;

    expect(() => parseProofPlan(input)).toThrow();
  });
});

describe('proof execution contracts', () => {
  it('accepts sanitized output and hashed artifacts', () => {
    const output = {
      summary: 'one assertion failed',
      originalBytes: 20,
      truncated: false,
      redacted: true,
    };

    expect(
      parseProofExecutionResult({
        planDigest: '6'.repeat(64),
        commandDigest: '4'.repeat(64),
        revision: 'head',
        sha: '2'.repeat(40),
        outcome: 'failed',
        exitCode: 1,
        durationMs: 25,
        stdout: output,
        stderr: output,
        artifacts: [
          { kind: 'stderr', sha256: SHA256, sizeBytes: 20 },
        ],
        recordedAt: '2026-09-07T12:00:00.000Z',
      }),
    ).toMatchObject({ outcome: 'failed', exitCode: 1 });
  });

  it('rejects a passing result with a nonzero exit code', () => {
    const output = {
      summary: '',
      originalBytes: 0,
      truncated: false,
      redacted: false,
    };

    expect(() =>
      parseProofExecutionResult({
        planDigest: '6'.repeat(64),
        commandDigest: '4'.repeat(64),
        revision: 'base',
        sha: '1'.repeat(40),
        outcome: 'passed',
        exitCode: 1,
        durationMs: 1,
        stdout: output,
        stderr: output,
        artifacts: [],
        recordedAt: '2026-09-07T12:00:00.000Z',
      }),
    ).toThrow('passing proof must exit with code zero');
  });

  it('rejects a failing result without an exit code', () => {
    const output = {
      summary: '',
      originalBytes: 0,
      truncated: false,
      redacted: false,
    };

    expect(() =>
      parseProofExecutionResult({
        planDigest: '6'.repeat(64),
        commandDigest: '4'.repeat(64),
        revision: 'head',
        sha: '2'.repeat(40),
        outcome: 'failed',
        exitCode: null,
        durationMs: 1,
        stdout: output,
        stderr: output,
        artifacts: [],
        recordedAt: '2026-09-07T12:00:00.000Z',
      }),
    ).toThrow('failing proof must have a nonzero exit code');
  });
});
