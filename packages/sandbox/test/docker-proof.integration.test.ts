import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProofPlan } from '@walkz/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  executeProofInContainer,
  executeProofPair,
  prepareProofImage,
} from '../src/index.js';

const image = process.env.WALKZ_DOCKER_TEST_IMAGE;
const dockerTest = image === undefined ? it.skip : it;
const roots: string[] = [];
const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);

function plan(script: string, timeoutMs = 10_000): ProofPlan {
  if (image === undefined) {
    throw new Error('WALKZ_DOCKER_TEST_IMAGE is required.');
  }
  const content = Buffer.from(script);
  return {
    schemaVersion: 1,
    runId: 'docker-integration',
    findingFingerprint: 'a'.repeat(64),
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    containerImage: image,
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
    commandDigest: 'b'.repeat(64),
    files: [
      {
        path: '.walkz-proof/reproducer.mjs',
        contentBase64: content.toString('base64'),
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    ],
    limits: {
      timeoutMs,
      maxOutputBytesPerStream: 16_384,
      memoryBytes: 256 * 1_024 * 1_024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 64,
      maxWritableBytes: 16 * 1_024 * 1_024,
    },
  };
}

async function workspace(revision: 'base' | 'head') {
  const root = await mkdtemp(join(tmpdir(), 'walkz real proof '));
  roots.push(root);
  await writeFile(join(root, 'value.txt'), revision + '\n');
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

describe('Docker proof integration', () => {
  dockerTest(
    'prepares the pinned image with a temporary credential-free config',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'walkz real image '));
      roots.push(root);
      const result = await prepareProofImage(
        plan('process.exit(0);'),
        root,
        { temporaryRoot: root },
      );

      expect(result.status).toBe('ready');
      await expect(readdir(root)).resolves.toEqual([]);
    },
    120_000,
  );

  dockerTest(
    'enforces the locked runtime for the same base and head command',
    async () => {
      const base = await workspace('base');
      const head = await workspace('head');
      const probe = String.raw`
import { readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

const failures = [];
if (process.getuid?.() === 0) failures.push('root user');
if (process.env.GROQ_API_KEY) failures.push('host secret');
if (Object.keys(networkInterfaces()).some((name) => name !== 'lo')) {
  failures.push('network interface');
}
const status = readFileSync('/proc/self/status', 'utf8');
if (!/^NoNewPrivs:\s+1$/m.test(status)) failures.push('new privileges');
if (!/^CapEff:\s+0+$/m.test(status)) failures.push('capabilities');
if (readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim() !== '64') {
  failures.push('pid limit');
}
if (readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim() !== '268435456') {
  failures.push('memory limit');
}
const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8')
  .trim().split(' ').map(Number);
if (quota / period > 1) failures.push('cpu limit');
const temporary = statfsSync('/tmp');
if (temporary.blocks * temporary.bsize > 16777216) failures.push('disk limit');
for (const path of ['/workspace/escape.txt', '/walkz-root-write']) {
  try {
    writeFileSync(path, 'escape');
    failures.push('writable ' + path);
  } catch {}
}
writeFileSync('/tmp/proof-output', readFileSync('value.txt'));
if (failures.length > 0) {
  console.error(failures.join(', '));
  process.exit(1);
}
console.log('locked');
`;

      const result = await executeProofPair(
        plan(probe),
        'c'.repeat(64),
        { base, head },
        {
          parentEnvironment: {
            ...process.env,
            GROQ_API_KEY: 'must-not-reach-container',
          },
        },
      );

      expect(result.base).toMatchObject({
        outcome: 'passed',
        sha: BASE_SHA,
      });
      expect(result.head).toMatchObject({
        outcome: 'passed',
        sha: HEAD_SHA,
      });
      expect(result.base.stdout.summary).toContain('locked');
      await expect(readdir(base.path)).resolves.toEqual(['value.txt']);
      await expect(readdir(head.path)).resolves.toEqual(['value.txt']);
    },
    60_000,
  );

  dockerTest(
    'removes the container and child process after timeout',
    async () => {
      const target = await workspace('base');
      const script = String.raw`
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
});
console.log('child started');
setInterval(() => {}, 1000);
`;

      const result = await executeProofInContainer(
        plan(script, 2_000),
        'c'.repeat(64),
        target,
      );

      expect(result.outcome).toBe('timed_out');
      expect(result.stdout.summary).toContain('child started');
      await expect(readdir(target.path)).resolves.toEqual(['value.txt']);
    },
    30_000,
  );

  dockerTest(
    'removes the container and child process after cancellation',
    async () => {
      const target = await workspace('head');
      const controller = new AbortController();
      const cancellation = setTimeout(() => controller.abort(), 2_000);
      const script = String.raw`
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
});
console.log('child started');
setInterval(() => {}, 1000);
`;

      try {
        const result = await executeProofInContainer(
          plan(script),
          'c'.repeat(64),
          target,
          { signal: controller.signal },
        );

        expect(result.outcome).toBe('cancelled');
        expect(result.stdout.summary).toContain('child started');
        await expect(readdir(target.path)).resolves.toEqual(['value.txt']);
      } finally {
        clearTimeout(cancellation);
      }
    },
    30_000,
  );
});
