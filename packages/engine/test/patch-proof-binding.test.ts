import { describe, expect, it } from 'vitest';

import { createDefaultWalkzConfig } from '@walkz/contracts';

import {
  bindPatchProofToRepositoryCommand,
  createPatchReproofBudget,
  digestProofCommand,
} from '../src/index.js';

const command = { executable: 'npm', args: ['test'], cwd: '.' };
const regressionCommand = { executable: 'npm', args: ['run', 'typecheck'], cwd: '.' };
const optionalCommand = { executable: 'npm', args: ['run', 'build'], cwd: '.' };
const image = `node@sha256:${'a'.repeat(64)}`;

function config() {
  return {
    ...createDefaultWalkzConfig([{
      id: 'test',
      ...command,
      required: true,
    }, {
      id: 'typecheck',
      ...regressionCommand,
      required: true,
    }, {
      id: 'build',
      ...optionalCommand,
      required: false,
    }]),
    commandApprovalPolicy: 'trusted_config' as const,
  };
}

describe('hosted patch proof binding', () => {
  it('reconstructs a deterministic no-source proof plan', () => {
    const binding = bindPatchProofToRepositoryCommand({
      reviewRunId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
      findingFingerprint: 'b'.repeat(64),
      baseSha: 'c'.repeat(40),
      headSha: 'd'.repeat(40),
      commandDigest: digestProofCommand(command),
      containerImage: image,
      config: config(),
    });

    expect(binding.plan.command).toEqual(command);
    expect(binding.plan.files).toEqual([]);
    expect(binding.regressionPlans.map((plan) => plan.command))
      .toEqual([regressionCommand]);
    expect(binding.authorization.authorizedCommandDigests).toEqual(new Set([
      digestProofCommand(command),
      digestProofCommand(regressionCommand),
    ]));
    expect(binding.plan.containerImage).toBe(image);
    expect(binding.planDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(createPatchReproofBudget(binding, 1_000)).toMatchObject({
      maxAttempts: 2,
      maxTotalDurationMs: 240_000,
      deadlineMs: 241_000,
    });
  });

  it('rejects commands that were not explicitly trusted', () => {
    expect(() => bindPatchProofToRepositoryCommand({
      reviewRunId: '3d963b52-8203-4ba6-bcac-15bf132371f0',
      findingFingerprint: 'b'.repeat(64),
      baseSha: 'c'.repeat(40),
      headSha: 'd'.repeat(40),
      commandDigest: digestProofCommand(command),
      containerImage: image,
      config: createDefaultWalkzConfig([{
        id: 'test',
        ...command,
        required: true,
      }]),
    })).toThrow('trusted repository command');
  });
});
