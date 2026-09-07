import type {
  Finding,
  LocalVerdictInput,
} from '@walkz/contracts';
import { describe, expect, it } from 'vitest';

import { adjudicateLocalVerdict } from '../src/index.js';

function finding(
  evidenceLevel: Finding['evidenceLevel'],
  lifecycleStatus: Finding['lifecycleStatus'] =
    evidenceLevel === 'VERIFIED'
      ? 'verified'
      : evidenceLevel === 'SUPPORTED'
        ? 'supported'
        : 'unverified',
): Finding {
  return {
    fingerprint: evidenceLevel.toLowerCase().padEnd(64, '0'),
    category: 'correctness',
    severity: 'high',
    file: 'src/math.ts',
    line: 7,
    claim: 'The boundary returns the wrong value.',
    failureMechanism: 'The fallback is skipped.',
    suggestedProof: 'Run the boundary test.',
    lifecycleStatus,
    evidenceLevel,
    advisoryConfidence: 1,
    evidence: [],
    dismissal: null,
    fix: null,
  };
}

function verdictInput(
  overrides: Partial<LocalVerdictInput> = {},
): LocalVerdictInput {
  return {
    contextStatus: 'complete',
    checkStatus: 'complete',
    providerStatus: 'complete',
    proofStatus: 'not_requested',
    findings: [],
    blockingEvidenceLevels: ['VERIFIED'],
    humanJudgmentRequired: false,
    ...overrides,
  };
}

describe('adjudicateLocalVerdict', () => {
  it.each([
    [
      { contextStatus: 'incomplete' },
      'context_incomplete',
    ],
    [
      { checkStatus: 'incomplete' },
      'checks_incomplete',
    ],
    [
      { providerStatus: 'incomplete' },
      'provider_incomplete',
    ],
    [
      { proofStatus: 'incomplete' },
      'proof_incomplete',
    ],
  ] as const)(
    'never ships when required evidence is missing',
    (overrides, reason) => {
      expect(adjudicateLocalVerdict(verdictInput(overrides))).toEqual({
        verdict: 'INCONCLUSIVE',
        reasons: [reason],
      });
    },
  );

  it.each([
    [{ contextStatus: 'error' }, 'context_error'],
    [{ checkStatus: 'error' }, 'checks_error'],
  ] as const)('returns an infrastructure error', (overrides, reason) => {
    expect(adjudicateLocalVerdict(verdictInput(overrides))).toEqual({
      verdict: 'ERROR',
      reasons: [reason],
    });
  });

  it('blocks verified findings by default', () => {
    expect(
      adjudicateLocalVerdict(
        verdictInput({ findings: [finding('VERIFIED')] }),
      ),
    ).toEqual({
      verdict: 'FIX',
      reasons: ['blocking_verified_finding'],
    });
  });

  it('blocks supported findings only when configured', () => {
    expect(
      adjudicateLocalVerdict(
        verdictInput({ findings: [finding('SUPPORTED')] }),
      ).verdict,
    ).toBe('SHIP');
    expect(
      adjudicateLocalVerdict(
        verdictInput({
          findings: [finding('SUPPORTED')],
          blockingEvidenceLevels: ['VERIFIED', 'SUPPORTED'],
        }),
      ),
    ).toEqual({
      verdict: 'FIX',
      reasons: ['blocking_supported_finding'],
    });
  });

  it('never blocks an unverified finding at maximum confidence', () => {
    expect(
      adjudicateLocalVerdict(
        verdictInput({ findings: [finding('UNVERIFIED')] }),
      ).verdict,
    ).toBe('SHIP');
  });

  it('ignores findings that are dismissed or fixed', () => {
    expect(
      adjudicateLocalVerdict(
        verdictInput({
          findings: [
            finding('VERIFIED', 'dismissed'),
            finding('VERIFIED', 'fixed'),
          ],
        }),
      ).verdict,
    ).toBe('SHIP');
  });

  it('allows an explicitly skipped provider', () => {
    expect(
      adjudicateLocalVerdict(
        verdictInput({ providerStatus: 'not_requested' }),
      ),
    ).toEqual({ verdict: 'SHIP', reasons: ['no_blocking_evidence'] });
  });

  it('routes unresolved judgment to a person', () => {
    expect(
      adjudicateLocalVerdict(
        verdictInput({ humanJudgmentRequired: true }),
      ),
    ).toEqual({ verdict: 'HUMAN', reasons: ['human_judgment_required'] });
  });

  it('keeps a known blocker when other evidence is incomplete', () => {
    expect(
      adjudicateLocalVerdict(
        verdictInput({
          providerStatus: 'incomplete',
          findings: [finding('VERIFIED')],
        }),
      ).verdict,
    ).toBe('FIX');
  });

  it('gives infrastructure errors precedence over findings', () => {
    expect(
      adjudicateLocalVerdict(
        verdictInput({
          contextStatus: 'error',
          findings: [finding('VERIFIED')],
        }),
      ).verdict,
    ).toBe('ERROR');
  });
});
