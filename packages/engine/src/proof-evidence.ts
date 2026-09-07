import type {
  Evidence,
  Finding,
  LocalVerdictInput,
  ProofExecutionResult,
  ProofPlan,
} from '@walkz/contracts';
import {
  parseProofExecutionResult,
  parseProofPlan,
} from '@walkz/contracts';

import { fingerprintProofPlan } from './proof-plan.js';

export type CounterfactualProofClassification =
  | 'verified'
  | 'not_verified'
  | 'incomplete'
  | 'invalid';

export type CounterfactualProofReason =
  | 'base_passed_head_failed'
  | 'outcomes_do_not_show_regression'
  | 'execution_incomplete'
  | 'provenance_mismatch';

export interface CounterfactualProofAssessment {
  classification: CounterfactualProofClassification;
  proofStatus: 'complete' | 'incomplete';
  reason: CounterfactualProofReason;
  finding: Finding;
  evidence: Evidence | null;
}

export interface CounterfactualProofPairInput {
  base: unknown;
  head: unknown;
}

export interface ProofVerdictBinding {
  bound: boolean;
  input: LocalVerdictInput;
}

function equalDigest(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parsePair(
  input: CounterfactualProofPairInput,
): { base: ProofExecutionResult; head: ProofExecutionResult } | null {
  try {
    return {
      base: parseProofExecutionResult(input.base),
      head: parseProofExecutionResult(input.head),
    };
  } catch {
    return null;
  }
}

function hasExpectedProvenance(
  plan: ProofPlan,
  planDigest: string,
  finding: Finding,
  base: ProofExecutionResult,
  head: ProofExecutionResult,
): boolean {
  return (
    equalDigest(plan.findingFingerprint, finding.fingerprint) &&
    base.revision === 'base' &&
    head.revision === 'head' &&
    equalDigest(base.sha, plan.baseSha) &&
    equalDigest(head.sha, plan.headSha) &&
    equalDigest(base.planDigest, planDigest) &&
    equalDigest(head.planDigest, planDigest) &&
    equalDigest(base.commandDigest, plan.commandDigest) &&
    equalDigest(head.commandDigest, plan.commandDigest)
  );
}

function summary(result: ProofExecutionResult): string {
  return [result.stdout.summary, result.stderr.summary]
    .filter((value) => value.length > 0)
    .join('\n');
}

function evidenceFromPair(
  plan: ProofPlan,
  planDigest: string,
  base: ProofExecutionResult,
  head: ProofExecutionResult,
): Evidence {
  const baseSummary = summary(base);
  const headSummary = summary(head);
  return {
    kind: 'counterfactual_proof',
    planDigest,
    commandDigest: plan.commandDigest,
    baseSha: plan.baseSha,
    headSha: plan.headSha,
    baseOutcome: base.outcome,
    headOutcome: head.outcome,
    baseExitCode: base.exitCode,
    headExitCode: head.exitCode,
    durationMs: base.durationMs + head.durationMs,
    sanitizedSummary:
      'base:\n' + baseSummary + '\nhead:\n' + headSummary,
    artifactHashes: [
      ...base.artifacts.map((artifact) => artifact.sha256),
      ...head.artifacts.map((artifact) => artifact.sha256),
    ],
    recordedAt:
      Date.parse(base.recordedAt) >= Date.parse(head.recordedAt)
        ? base.recordedAt
        : head.recordedAt,
  };
}

function attachEvidence(finding: Finding, evidence: Evidence): Finding {
  return {
    ...finding,
    evidence: [...finding.evidence, evidence],
  };
}

function verifyFinding(finding: Finding, evidence: Evidence): Finding {
  return {
    ...attachEvidence(finding, evidence),
    lifecycleStatus: 'verified',
    evidenceLevel: 'VERIFIED',
  };
}

function invalidAssessment(finding: Finding): CounterfactualProofAssessment {
  return {
    classification: 'invalid',
    proofStatus: 'incomplete',
    reason: 'provenance_mismatch',
    finding,
    evidence: null,
  };
}

export function createIncompleteCounterfactualProofAssessment(
  finding: Finding,
): CounterfactualProofAssessment {
  return {
    classification: 'incomplete',
    proofStatus: 'incomplete',
    reason: 'execution_incomplete',
    finding,
    evidence: null,
  };
}

export function assessCounterfactualProof(
  finding: Finding,
  planInput: unknown,
  pairInput: CounterfactualProofPairInput,
): CounterfactualProofAssessment {
  let plan: ProofPlan;
  let planDigest: string;
  try {
    plan = parseProofPlan(planInput);
    planDigest = fingerprintProofPlan(plan);
  } catch {
    return invalidAssessment(finding);
  }

  const pair = parsePair(pairInput);
  if (
    pair === null ||
    !hasExpectedProvenance(plan, planDigest, finding, pair.base, pair.head)
  ) {
    return invalidAssessment(finding);
  }

  const evidence = evidenceFromPair(plan, planDigest, pair.base, pair.head);
  if (pair.base.outcome === 'passed' && pair.head.outcome === 'failed') {
    return {
      classification: 'verified',
      proofStatus: 'complete',
      reason: 'base_passed_head_failed',
      finding: verifyFinding(finding, evidence),
      evidence,
    };
  }

  if (
    pair.base.outcome === 'passed' ||
    pair.base.outcome === 'failed' ||
    pair.head.outcome === 'passed' ||
    pair.head.outcome === 'failed'
  ) {
    const complete =
      (pair.base.outcome === 'passed' || pair.base.outcome === 'failed') &&
      (pair.head.outcome === 'passed' || pair.head.outcome === 'failed');
    if (complete) {
      return {
        classification: 'not_verified',
        proofStatus: 'complete',
        reason: 'outcomes_do_not_show_regression',
        finding: attachEvidence(finding, evidence),
        evidence,
      };
    }
  }

  return {
    classification: 'incomplete',
    proofStatus: 'incomplete',
    reason: 'execution_incomplete',
    finding: attachEvidence(finding, evidence),
    evidence,
  };
}

export function bindProofAssessmentToVerdictInput(
  input: LocalVerdictInput,
  assessment: CounterfactualProofAssessment,
): ProofVerdictBinding {
  const matches = input.findings.filter(
    (finding) =>
      equalDigest(finding.fingerprint, assessment.finding.fingerprint),
  );
  if (matches.length !== 1) {
    return {
      bound: false,
      input: { ...input, proofStatus: 'incomplete' },
    };
  }

  return {
    bound: true,
    input: {
      ...input,
      proofStatus:
        input.proofStatus === 'incomplete' ||
        assessment.proofStatus === 'incomplete'
          ? 'incomplete'
          : 'complete',
      findings: input.findings.map((finding) =>
        equalDigest(finding.fingerprint, assessment.finding.fingerprint)
          ? assessment.finding
          : finding,
      ),
    },
  };
}
