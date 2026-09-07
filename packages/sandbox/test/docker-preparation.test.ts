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
  prepareProofImage,
  type DockerPreparationExecutor,
} from '../src/index.js';

const roots: string[] = [];

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
): CommandExecutionResult {
  return {
    outcome,
    exitCode: outcome === 'succeeded' ? 0 : null,
    signal: null,
    durationMs: 10,
    stdout: output(),
    stderr: output(),
    termination: {
      requested: outcome === 'cancelled' ? 'cancelled' : null,
      accepted: outcome === 'cancelled',
      guarantee: 'best_effort',
    },
  };
}

function plan(): ProofPlan {
  const content = Buffer.from('process.exit(0);\n');
  return {
    schemaVersion: 1,
    runId: 'run-1',
    findingFingerprint: 'a'.repeat(64),
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
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

async function directory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.length = 0;
});

describe('prepareProofImage', () => {
  it('pulls and inspects the pinned image with an empty Docker config', async () => {
    const workingDirectory = await directory('walkz image work ');
    const temporaryRoot = await directory('walkz image temp ');
    const calls: CommandSpec[] = [];
    const executor: DockerPreparationExecutor = async (spec) => {
      calls.push(spec);
      const dockerConfig = spec.environment?.DOCKER_CONFIG;
      expect(dockerConfig).toBeDefined();
      await expect(
        readFile(join(dockerConfig!, 'config.json'), 'utf8'),
      ).resolves.toBe('{"auths":{}}\n');
      return execution();
    };

    const result = await prepareProofImage(plan(), workingDirectory, {
      executor,
      temporaryRoot,
      parentEnvironment: {
        PATH: process.env.PATH,
        GROQ_API_KEY: 'must-not-reach-preparation',
      },
    });

    expect(result.status).toBe('ready');
    expect(calls.map((call) => call.args)).toEqual([
      ['image', 'pull', plan().containerImage],
      ['image', 'inspect', plan().containerImage],
    ]);
    expect(JSON.stringify(calls)).not.toContain('must-not-reach-preparation');
    await expect(readdir(temporaryRoot)).resolves.toEqual([]);
  });

  it.each(['cancelled', 'spawn_error'] as const)(
    'stops after a %s pull and removes its Docker config',
    async (outcome) => {
      const workingDirectory = await directory('walkz image work ');
      const temporaryRoot = await directory('walkz image temp ');
      let calls = 0;
      const executor: DockerPreparationExecutor = async () => {
        calls += 1;
        return execution(outcome);
      };

      const result = await prepareProofImage(plan(), workingDirectory, {
        executor,
        temporaryRoot,
      });

      expect(result.status).toBe(
        outcome === 'cancelled' ? 'cancelled' : 'infrastructure_error',
      );
      expect(result.inspection).toBeNull();
      expect(calls).toBe(1);
      await expect(readdir(temporaryRoot)).resolves.toEqual([]);
    },
  );
});
