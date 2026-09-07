import type { Finding, ProofExecutionResult, ProofPlan } from '@walkz/contracts';
import { describe, expect, it } from 'vitest';

import {
  adjudicateLocalVerdict,
  assessCounterfactualProof,
  digestProofCommand,
  fingerprintProofPlan,
} from '../src/index.js';

const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const FINDING_FINGERPRINT = '4'.repeat(64);
const COMMAND: ProofPlan['command'] = {
  executable: 'node',
  args: ['.walkz-proof/reproducer.mjs'],
  cwd: '.',
};
const COMMAND_DIGEST = digestProofCommand(COMMAND);

function finding(): Finding {
  return {
    fingerprint: FINDING_FINGERPRINT,
    category: 'correctness',
    severity: 'high',
    file: 'src/value.ts',
    line: 4,
    claim: 'The changed value is incorrect.',
    failureMechanism: 'The new branch returns the fallback.',
    suggestedProof: 'Run the regression reproducer.',
    lifecycleStatus: 'unverified',
    evidenceLevel: 'UNVERIFIED',
    advisoryConfidence: 0.9,
    evidence: [],
    dismissal: null,
    fix: null,
  };
}

function plan(): ProofPlan {
  return {
    schemaVersion: 1,
    runId: 'proof-run',
    findingFingerprint: FINDING_FINGERPRINT,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    containerImage: 'node:24@sha256:' + '5'.repeat(64),
    isolation: {
      network: 'none',
      readOnlyRootFilesystem: true,
      dropCapabilities: 'all',
      noNewPrivileges: true,
    },
    command: COMMAND,
    commandDigest: COMMAND_DIGEST,
    files: [],
    limits: {
      timeoutMs: 1_000,
      maxOutputBytesPerStream: 1_024,
      memoryBytes: 64 * 1_024 * 1_024,
      nanoCpus: 100_000_000,
      pidsLimit: 16,
      maxWritableBytes: 1_024 * 1_024,
    },
  };
}

function result(
  revision: 'base' | 'head',
  outcome: ProofExecutionResult['outcome'],
  overrides: Partial<ProofExecutionResult> = {},
): ProofExecutionResult {
  const proofPlan = plan();
  return {
    planDigest: fingerprintProofPlan(proofPlan),
    commandDigest: COMMAND_DIGEST,
    revision,
    sha: revision === 'base' ? BASE_SHA : HEAD_SHA,
    outcome,
    exitCode: outcome === 'passed' ? 0 : outcome === 'failed' ? 1 : null,
    durationMs: 12,
    stdout: {
      summary: revision + ' stdout',
      originalBytes: 11,
      truncated: false,
      redacted: false,
    },
    stderr: {
      summary: revision + ' stderr',
      originalBytes: 11,
      truncated: false,
      redacted: false,
    },
    artifacts: [{ kind: 'stdout', sha256: revision === 'base' ? '6'.repeat(64) : '7'.repeat(64), sizeBytes: 11 }],
    recordedAt: revision === 'base' ? '2026-09-07T17:00:00.000Z' : '2026-09-07T17:00:01.000Z',
    ...overrides,
  };
}

function verdict(proofStatus: 'complete' | 'incomplete', proofFinding: Finding) {
  return adjudicateLocalVerdict({
    contextStatus: 'complete',
    checkStatus: 'complete',
    providerStatus: 'complete',
    proofStatus,
    findings: [proofFinding],
    blockingEvidenceLevels: ['VERIFIED'],
    humanJudgmentRequired: false,
  });
}

describe('assessCounterfactualProof', () => {
  it('binds matching base-pass and head-fail evidence to a verified finding', () => {
    const assessment = assessCounterfactualProof(finding(), plan(), {
      base: result('base', 'passed'),
      head: result('head', 'failed'),
    });

    expect(assessment).toMatchObject({
      classification: 'verified',
      proofStatus: 'complete',
      reason: 'base_passed_head_failed',
      finding: { evidenceLevel: 'VERIFIED', lifecycleStatus: 'verified' },
      evidence: {
        kind: 'counterfactual_proof',
        planDigest: fingerprintProofPlan(plan()),
        commandDigest: COMMAND_DIGEST,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        baseOutcome: 'passed',
        headOutcome: 'failed',
        artifactHashes: ['6'.repeat(64), '7'.repeat(64)],
        sanitizedSummary: 'base:\nbase stdout\nbase stderr\nhead:\nhead stdout\nhead stderr',
      },
    });
    expect(verdict(assessment.proofStatus, assessment.finding)).toEqual({
      verdict: 'FIX',
      reasons: ['blocking_verified_finding'],
    });
  });

  it.each([
    ['equal pass outcomes', 'passed', 'passed'],
    ['equal fail outcomes', 'failed', 'failed'],
    ['inverse outcomes', 'failed', 'passed'],
  ] as const)('%s cannot block a finding', (_, baseOutcome, headOutcome) => {
    const assessment = assessCounterfactualProof(finding(), plan(), {
      base: result('base', baseOutcome),
      head: result('head', headOutcome),
    });

    expect(assessment).toMatchObject({
      classification: 'not_verified',
      proofStatus: 'complete',
      finding: { evidenceLevel: 'UNVERIFIED' },
    });
    expect(verdict(assessment.proofStatus, assessment.finding)).toEqual({
      verdict: 'SHIP',
      reasons: ['no_blocking_evidence'],
    });
  });

  it.each(['timed_out', 'cancelled', 'infrastructure_error'] as const)(
    '%s proof outcomes are inconclusive',
    (outcome) => {
      const assessment = assessCounterfactualProof(finding(), plan(), {
        base: result('base', 'passed'),
        head: result('head', outcome),
      });

      expect(assessment).toMatchObject({
        classification: 'incomplete',
        proofStatus: 'incomplete',
        reason: 'execution_incomplete',
      });
      expect(verdict(assessment.proofStatus, assessment.finding)).toEqual({
        verdict: 'INCONCLUSIVE',
        reasons: ['proof_incomplete'],
      });
    },
  );

  it.each([
    ['revision SHA', { sha: HEAD_SHA }],
    ['plan digest', { planDigest: '8'.repeat(64) }],
    ['command digest', { commandDigest: '9'.repeat(64) }],
    ['revision label', { revision: 'head' as const, sha: HEAD_SHA }],
  ] as const)('rejects a mismatched %s before it can block', (_, override) => {
    const assessment = assessCounterfactualProof(finding(), plan(), {
      base: result('base', 'passed', override),
      head: result('head', 'failed'),
    });

    expect(assessment).toMatchObject({
      classification: 'invalid',
      proofStatus: 'incomplete',
      reason: 'provenance_mismatch',
      evidence: null,
      finding: { evidenceLevel: 'UNVERIFIED', evidence: [] },
    });
    expect(verdict(assessment.proofStatus, assessment.finding)).toEqual({
      verdict: 'INCONCLUSIVE',
      reasons: ['proof_incomplete'],
    });
  });
});
