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
      'Walkz review\n\nVerdict: SHIP\n\nChecks:\n  none\n\n' +
        'Findings:\n  none\n',
    );
  });

  it('renders machine-readable JSON without a line index map', () => {
    const rendered = renderJsonReport(result());
    const parsed = JSON.parse(rendered);

    expect(parsed).toMatchObject({
      runId: 'run-1',
      verdict: 'SHIP',
      configHash: '1'.repeat(64),
      deterministicChecks: null,
      findings: [],
    });
    expect(rendered).toMatch(/\n$/);
  });
});
