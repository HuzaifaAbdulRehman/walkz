import type {
  Finding,
  LocalVerdictDecision,
  LocalVerdictInput,
  VerdictReason,
} from '@walkz/contracts';

function isActiveFinding(finding: Finding): boolean {
  return (
    finding.lifecycleStatus !== 'dismissed' &&
    finding.lifecycleStatus !== 'fixed'
  );
}

function blockingReasons(input: LocalVerdictInput): VerdictReason[] {
  const allowed = new Set(input.blockingEvidenceLevels);
  const levels = new Set(
    input.findings
      .filter(isActiveFinding)
      .map((finding) => finding.evidenceLevel),
  );
  const reasons: VerdictReason[] = [];
  if (allowed.has('VERIFIED') && levels.has('VERIFIED')) {
    reasons.push('blocking_verified_finding');
  }
  if (allowed.has('SUPPORTED') && levels.has('SUPPORTED')) {
    reasons.push('blocking_supported_finding');
  }
  return reasons;
}

function errorReasons(input: LocalVerdictInput): VerdictReason[] {
  const reasons: VerdictReason[] = [];
  if (input.contextStatus === 'error') {
    reasons.push('context_error');
  }
  if (input.checkStatus === 'error') {
    reasons.push('checks_error');
  }
  return reasons;
}

function incompleteReasons(input: LocalVerdictInput): VerdictReason[] {
  const reasons: VerdictReason[] = [];
  if (input.contextStatus === 'incomplete') {
    reasons.push('context_incomplete');
  }
  if (input.checkStatus === 'incomplete') {
    reasons.push('checks_incomplete');
  }
  if (input.providerStatus === 'incomplete') {
    reasons.push('provider_incomplete');
  }
  if (input.proofStatus === 'incomplete') {
    reasons.push('proof_incomplete');
  }
  return reasons;
}

export function adjudicateLocalVerdict(
  input: LocalVerdictInput,
): LocalVerdictDecision {
  const errors = errorReasons(input);
  if (errors.length > 0) {
    return { verdict: 'ERROR', reasons: errors };
  }

  const blockers = blockingReasons(input);
  if (blockers.length > 0) {
    return { verdict: 'FIX', reasons: blockers };
  }

  const incomplete = incompleteReasons(input);
  if (incomplete.length > 0) {
    return { verdict: 'INCONCLUSIVE', reasons: incomplete };
  }

  if (input.humanJudgmentRequired) {
    return { verdict: 'HUMAN', reasons: ['human_judgment_required'] };
  }

  return { verdict: 'SHIP', reasons: ['no_blocking_evidence'] };
}
