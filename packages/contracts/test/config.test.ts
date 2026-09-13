import {
  createDefaultWalkzConfig,
  mergeCliOverrides,
  parseModelReviewResponse,
  parseWalkzConfig,
  validateReviewRequest,
} from '../src/index.js';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

describe('repository configuration', () => {
  it('creates a strict free-first default', () => {
    const config = createDefaultWalkzConfig();

    expect(config).toMatchObject({
      schemaVersion: 1,
      provider: {
        name: 'groq',
        model: 'auto',
      },
      blockingEvidenceLevels: ['VERIFIED'],
      policyPacks: [
        'security-core@1',
        'supply-chain@1',
        'delivery-safety@1',
      ],
      commandApprovalPolicy: 'prompt',
      premiumEnabled: false,
      spendingLimitUsd: 0,
    });
  });

  it('rejects unknown fields, duplicate commands, and unverified blocking', () => {
    const base = createDefaultWalkzConfig([
      {
        id: 'test',
        executable: 'npm',
        args: ['test'],
        cwd: '.',
        required: true,
      },
    ]);

    expect(() => parseWalkzConfig({ ...base, surprise: true })).toThrow(
      ZodError,
    );
    expect(() =>
      parseWalkzConfig({
        ...base,
        commands: [...base.commands, base.commands[0]],
      }),
    ).toThrow(/unique/i);
    expect(() =>
      parseWalkzConfig({
        ...base,
        blockingEvidenceLevels: ['UNVERIFIED'],
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseWalkzConfig({
        ...base,
        policyPacks: ['unknown@1'],
      }),
    ).toThrow(ZodError);
    expect(() =>
      parseWalkzConfig({
        ...base,
        policyPacks: ['security-core@1', 'security-core@1'],
      }),
    ).toThrow(/unique/i);
  });

  it('preserves legacy configuration hashes by leaving packs optional', () => {
    const current = createDefaultWalkzConfig();
    const { policyPacks: _policyPacks, ...legacy } = current;

    expect(parseWalkzConfig(legacy)).not.toHaveProperty('policyPacks');
  });

  it('merges allowed CLI overrides without mutating the source config', () => {
    const source = createDefaultWalkzConfig();
    const merged = mergeCliOverrides(source, {
      baseBranch: 'release',
      model: 'selected-model',
    });

    expect(merged.baseBranch).toBe('release');
    expect(merged.provider.model).toBe('selected-model');
    expect(source.baseBranch).toBeNull();
    expect(source.provider.model).toBe('auto');
  });
});

describe('review boundary schemas', () => {
  it('validates a bounded review request', () => {
    const request = validateReviewRequest({
      repositoryRoot: 'D:\\repo',
      baseRef: 'main',
      headRef: 'HEAD',
      trigger: 'local',
      configVersion: 1,
      configHash: 'a'.repeat(64),
      runBudget: {
        maxDurationMs: 60_000,
        maxModelTokens: 8_000,
        maxProofAttempts: 0,
      },
      callerCapabilities: {
        canRunCommands: true,
        canUseModel: true,
        canWriteFiles: false,
      },
    });

    expect(request.trigger).toBe('local');
    expect(request.configHash).toHaveLength(64);
  });

  it('parses a model response and rejects malformed JSON', () => {
    const response = parseModelReviewResponse(
      JSON.stringify({
        findings: [
          {
            category: 'correctness',
            severity: 'high',
            file: 'src/example.ts',
            line: 10,
            endLine: 12,
            claim: 'The branch drops a valid result.',
            failureMechanism: 'The early return skips the final item.',
            suggestedProof: 'Run the case with one item after the sentinel.',
            confidence: 0.8,
          },
        ],
      }),
    );

    expect(response.findings).toHaveLength(1);
    expect(() => parseModelReviewResponse('{broken')).toThrow(
      'Model response is not valid JSON.',
    );
  });

  it('rejects inverted model finding locations', () => {
    expect(() =>
      parseModelReviewResponse({
        findings: [
          {
            category: 'correctness',
            severity: 'high',
            file: 'src/example.ts',
            line: 12,
            endLine: 10,
            claim: 'The range is invalid.',
            failureMechanism: 'The end precedes the start.',
            suggestedProof: 'Validate the range.',
            confidence: 0.8,
          },
        ],
      }),
    ).toThrow(/endLine/);
  });

  it('rejects absolute and upward-traversing model paths', () => {
    const finding = {
      category: 'correctness',
      severity: 'high',
      line: 1,
      claim: 'The path is outside the repository.',
      failureMechanism: 'The path escapes the checkout.',
      suggestedProof: 'Reject the path before indexing it.',
      confidence: 0.8,
    };

    expect(() =>
      parseModelReviewResponse({
        findings: [{ ...finding, file: '../outside.ts' }],
      }),
    ).toThrow(/relative/);
    expect(() =>
      parseModelReviewResponse({
        findings: [{ ...finding, file: 'C:\\outside.ts' }],
      }),
    ).toThrow(/relative/);
  });
});
