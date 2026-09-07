import type {
  LocalReviewBudget,
  ProofCommand,
  ProofResourceLimits,
} from '@walkz/contracts';
import { describe, expect, it } from 'vitest';

import {
  allocateProofBudget,
  createProofPlan,
  digestProofCommand,
  fingerprintProofPlan,
  verifyProofPlan,
  type ProofBudget,
} from '../src/index.js';

const command: ProofCommand = {
  executable: 'node',
  args: ['.walkz-proof/reproducer.mjs'],
  cwd: '.',
};
const limits: ProofResourceLimits = {
  timeoutMs: 10_000,
  maxOutputBytesPerStream: 16_384,
  memoryBytes: 256 * 1_024 * 1_024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 64,
  maxWritableBytes: 1024 * 1_024,
};
const budget: ProofBudget = {
  maxAttempts: 2,
  maxTotalDurationMs: 60_000,
  maxAttemptDurationMs: 20_000,
  maxOutputBytesPerStream: 32_768,
  maxArtifactBytes: 2 * 1_024 * 1_024,
  deadlineMs: 70_000,
};
const authorization = {
  authorizedCommandDigests: new Set([digestProofCommand(command)]),
};

function input() {
  return {
    runId: 'run-1',
    findingFingerprint: 'a'.repeat(64),
    baseSha: '1'.repeat(40),
    headSha: '2'.repeat(40),
    containerImage: 'node:24@sha256:' + '3'.repeat(64),
    command,
    files: [
      {
        path: '.walkz-proof/reproducer.mjs',
        content: 'if (value !== 0) process.exit(1);',
      },
    ],
    limits,
  };
}

describe('proof command authorization', () => {
  it('produces a stable digest for the same normalized command', () => {
    expect(
      digestProofCommand({
        cwd: '.',
        args: ['.walkz-proof/reproducer.mjs'],
        executable: 'node',
      }),
    ).toBe(digestProofCommand(command));
  });

  it('rejects a command absent from the external approval set', () => {
    expect(() =>
      createProofPlan(
        input(),
        { authorizedCommandDigests: new Set() },
        budget,
      ),
    ).toThrow('has not been approved');
  });

  it('rejects malformed values in the external approval set', () => {
    expect(() =>
      createProofPlan(
        input(),
        { authorizedCommandDigests: new Set(['not-a-digest']) },
        budget,
      ),
    ).toThrow('must be SHA-256');
  });
});

describe('proof plan integrity', () => {
  it('binds the command and proof bytes into stable hashes', () => {
    const first = createProofPlan(input(), authorization, budget);
    const second = createProofPlan(input(), authorization, budget);

    expect(first.files[0]).toMatchObject({
      path: '.walkz-proof/reproducer.mjs',
      contentBase64: Buffer.from(
        'if (value !== 0) process.exit(1);',
      ).toString('base64'),
    });
    expect(first.isolation).toEqual({
      network: 'none',
      readOnlyRootFilesystem: true,
      dropCapabilities: 'all',
      noNewPrivileges: true,
    });
    expect(fingerprintProofPlan(first)).toBe(
      fingerprintProofPlan(second),
    );
  });

  it('changes the plan fingerprint when proof bytes change', () => {
    const first = createProofPlan(input(), authorization, budget);
    const changedInput = input();
    changedInput.files[0]!.content = 'process.exit(0);';
    const changed = createProofPlan(changedInput, authorization, budget);

    expect(fingerprintProofPlan(first)).not.toBe(
      fingerprintProofPlan(changed),
    );
  });

  it('rejects a plan whose command changed after approval', () => {
    const plan = createProofPlan(input(), authorization, budget);
    const changed = structuredClone(plan);
    changed.command.args.push('--changed');

    expect(() => verifyProofPlan(changed, authorization, budget)).toThrow(
      'command digest does not match',
    );
  });

  it('rejects a plan whose proof bytes changed after hashing', () => {
    const plan = createProofPlan(input(), authorization, budget);
    const changed = structuredClone(plan);
    changed.files[0]!.contentBase64 = Buffer.from('changed').toString(
      'base64',
    );

    expect(() => verifyProofPlan(changed, authorization, budget)).toThrow(
      'file digest does not match',
    );
  });

  it('rejects noncanonical base64', () => {
    const plan = createProofPlan(input(), authorization, budget);
    const changed = structuredClone(plan);
    changed.files[0]!.contentBase64 += '=';

    expect(() => verifyProofPlan(changed, authorization, budget)).toThrow(
      'canonical base64',
    );
  });

  it('rejects limits beyond the allocated budget', () => {
    const changedInput = input();
    changedInput.limits = { ...limits, timeoutMs: 30_000 };

    expect(() =>
      createProofPlan(changedInput, authorization, budget),
    ).toThrow('attempt budget');
  });

  it('rejects an internally inconsistent budget', () => {
    expect(() =>
      createProofPlan(input(), authorization, {
        ...budget,
        maxTotalDurationMs: 10_000,
        maxAttemptDurationMs: 20_000,
      }),
    ).toThrow('exceeds the total proof budget');
  });
});

describe('proof budget allocation', () => {
  const reviewBudget: LocalReviewBudget = {
    maxDurationMs: 120_000,
    maxModelTokens: 4_000,
    maxProofAttempts: 3,
    deadlineMs: 121_000,
  };

  it('uses only attempts and time left in the review budget', () => {
    expect(
      allocateProofBudget(reviewBudget, 101_000, {
        attemptsUsed: 1,
        maxTotalDurationMs: 60_000,
        maxAttemptDurationMs: 30_000,
      }),
    ).toEqual({
      status: 'available',
      budget: {
        maxAttempts: 2,
        maxTotalDurationMs: 20_000,
        maxAttemptDurationMs: 20_000,
        maxOutputBytesPerStream: 65_536,
        maxArtifactBytes: 16_777_216,
        deadlineMs: 121_000,
      },
    });
  });

  it('reports an exhausted attempt budget', () => {
    expect(
      allocateProofBudget(reviewBudget, 1_000, { attemptsUsed: 3 }),
    ).toEqual({
      status: 'exhausted',
      reason: 'attempts_exhausted',
    });
  });

  it('reports a reached review deadline', () => {
    expect(allocateProofBudget(reviewBudget, 121_000)).toEqual({
      status: 'exhausted',
      reason: 'deadline_reached',
    });
  });

  it('reports too little time for a valid proof attempt', () => {
    expect(allocateProofBudget(reviewBudget, 120_950)).toEqual({
      status: 'exhausted',
      reason: 'duration_exhausted',
    });
  });

  it('rejects allocations smaller than contract minimums', () => {
    expect(() =>
      allocateProofBudget(reviewBudget, 1_000, {
        maxOutputBytesPerStream: 1,
      }),
    ).toThrow('at least 1024');
  });

  it('rejects unsafe budget arithmetic', () => {
    expect(() =>
      allocateProofBudget(reviewBudget, Number.MAX_SAFE_INTEGER + 1),
    ).toThrow('safe integer');
  });
});
