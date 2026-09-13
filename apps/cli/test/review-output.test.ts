import type { LocalReviewPipelineResult } from '@walkz/engine';
import { describe, expect, it } from 'vitest';

import {
  mapVerdictToExitCode,
  renderJsonReport,
  renderTerminalReport,
} from '../src/index.js';

function result(
  verdict: LocalReviewPipelineResult['decision']['verdict'] = 'SHIP',
): LocalReviewPipelineResult {
  return {
    run: {
      runId: 'run-1',
      request: {
        repositoryRoot: 'C:\\repo',
        baseRef: 'main',
        headRef: 'HEAD',
        trigger: 'local',
        configVersion: 1,
        configHash: '1'.repeat(64),
        runBudget: {
          maxDurationMs: 1_000,
          maxModelTokens: 0,
          maxProofAttempts: 0,
        },
        callerCapabilities: {
          canRunCommands: true,
          canUseModel: false,
          canWriteFiles: false,
        },
      },
      config: {
        schemaVersion: 1,
        baseBranch: null,
        paths: { include: ['**/*'], exclude: [] },
        commands: [],
        commandTimeoutMs: 1_000,
        commandOutputBytesPerStream: 4_096,
        diffBudgetBytes: 4_096,
        fileBudget: 10,
        tokenBudget: 1_000,
        provider: { name: 'groq', model: 'auto' },
        triggerPolicy: 'manual',
        blockingEvidenceLevels: ['VERIFIED'],
        commandApprovalPolicy: 'prompt',
        premiumEnabled: false,
        spendingLimitUsd: 0,
      },
      status: verdict === 'SHIP' ? 'completed' : 'inconclusive',
      verdict,
      findings: [],
      startedAt: '2026-09-07T10:00:00.000Z',
      completedAt: '2026-09-07T10:00:01.000Z',
    },
    budget: {
      maxDurationMs: 1_000,
      maxModelTokens: 0,
      maxProofAttempts: 0,
      deadlineMs: 1_000,
    },
    context: null,
    deterministicChecks: null,
    provider: {
      status: 'not_requested',
      attempted: false,
      provider: null,
      model: null,
      promptVersion: null,
      schemaVersion: null,
      usage: null,
      requestId: null,
      promptTruncated: false,
      rejectedFindings: [],
      failureCode: null,
    },
    challenger: {
      status: 'not_requested',
      attempted: false,
      provider: null,
      model: null,
      promptVersion: null,
      schemaVersion: null,
      usage: null,
      requestId: null,
      promptTruncated: false,
      decisions: [],
      needsHuman: false,
      failureCode: null,
    },
    security: {
      status: 'not_requested',
      attempted: false,
      provider: null,
      model: null,
      promptVersion: null,
      schemaVersion: null,
      usage: null,
      requestId: null,
      promptTruncated: false,
      rejectedFindings: [],
      failureCode: null,
    },
    decision: { verdict, reasons: ['no_blocking_evidence'] },
    failure: null,
  };
}

describe('review output', () => {
  it.each([
    ['SHIP', 0],
    ['FIX', 1],
    ['HUMAN', 2],
    ['INCONCLUSIVE', 2],
    ['ERROR', 3],
  ] as const)('maps %s to exit code %s', (verdict, exitCode) => {
    expect(mapVerdictToExitCode(verdict)).toBe(exitCode);
  });

  it('renders a short terminal report', () => {
    expect(renderTerminalReport(result())).toBe(
      'Walkz review\n\nVerdict: SHIP\n' +
        'Policy packs: security-core@1, supply-chain@1, delivery-safety@1\n' +
        '\nChecks:\n  none\n\n' +
        'Findings:\n  none\n',
    );
  });

  it('reports the independent challenger without its rationale', () => {
    const reviewed = result();
    reviewed.challenger = {
      ...reviewed.challenger,
      status: 'complete',
      attempted: true,
      provider: 'groq',
      model: 'qwen/challenger',
      promptVersion: 'walkz-challenge-v1',
      schemaVersion: 'walkz-challenge-v1',
      requestId: 'request-2',
      decisions: [{
        findingFingerprint: 'a'.repeat(64),
        verdict: 'uphold',
      }],
    };

    expect(renderTerminalReport(reviewed)).toContain(
      'Challenger: groq / qwen/challenger',
    );
    expect(renderJsonReport(reviewed)).not.toContain('rationale');
  });

  it('renders machine-readable JSON without a line index map', () => {
    const rendered = renderJsonReport(result());
    const parsed = JSON.parse(rendered);

    expect(parsed).toMatchObject({
      runId: 'run-1',
      verdict: 'SHIP',
      configHash: '1'.repeat(64),
      policyPacks: [
        'security-core@1',
        'supply-chain@1',
        'delivery-safety@1',
      ],
      deterministicChecks: null,
      findings: [],
    });
    expect(renderTerminalReport(result())).toContain(
      'Policy packs: security-core@1, supply-chain@1, delivery-safety@1',
    );
    expect(rendered).toMatch(/\n$/);
  });
});
