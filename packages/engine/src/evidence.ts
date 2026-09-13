import {
  parseModelReviewResponse,
  type DeterministicCheckResult,
  type DeterministicCheckRun,
  type Finding,
} from '@walkz/contracts';
import type { DiffLineIndex } from '@walkz/git';

import {
  normalizeFinding,
  validateFindingLocation,
  type FindingLocationFailure,
} from './finding.js';
import { digestProofCommand } from './proof-plan.js';

export type FindingRejectionReason =
  | FindingLocationFailure
  | 'invalid_finding'
  | 'duplicate_fingerprint'
  | 'specialist_non_security_finding';

export interface FindingRejection {
  index: number;
  reason: FindingRejectionReason;
}

function locationAppears(
  output: string,
  file: string,
  line: number,
): boolean {
  const paths = [file, file.replaceAll('/', '\\')];
  const markers = paths.flatMap((path) => [
    path + ':' + line,
    path + '(' + line + ',',
  ]);

  return markers.some((marker) => {
    let offset = output.indexOf(marker);
    while (offset !== -1) {
      const before = offset === 0 ? '' : output[offset - 1] ?? '';
      const after = output[offset + marker.length] ?? '';
      const safeStart = offset === 0 || /[\s"'([\\/]/.test(before);
      const safeEnd = marker.includes('(') || !/[0-9]/.test(after);
      if (safeStart && safeEnd) {
        return true;
      }
      offset = output.indexOf(marker, offset + 1);
    }
    return false;
  });
}

function commandDigest(check: DeterministicCheckResult): string {
  return digestProofCommand({
    executable: check.command.executable,
    args: check.command.args,
    cwd: check.command.cwd ?? '.',
  });
}

function attachDeterministicSupport(
  finding: Finding,
  checks: DeterministicCheckRun,
  recordedAt: string,
): Finding {
  const supportingChecks = checks.checks.filter((check) => {
    if (check.execution.outcome !== 'failed') {
      return false;
    }
    return locationAppears(
      check.execution.stdout.text + '\n' + check.execution.stderr.text,
      finding.file,
      finding.line,
    );
  });
  if (supportingChecks.length === 0) {
    return finding;
  }

  return {
    ...finding,
    lifecycleStatus: 'supported',
    evidenceLevel: 'SUPPORTED',
    evidence: supportingChecks.map((check) => ({
      kind: 'deterministic_check',
      planDigest: null,
      commandDigest: commandDigest(check),
      baseSha: null,
      headSha: null,
      baseOutcome: null,
      headOutcome: check.execution.outcome,
      baseExitCode: null,
      headExitCode: check.execution.exitCode,
      durationMs: check.execution.durationMs,
      sanitizedSummary:
        check.commandId +
        ' failed and referenced ' +
        finding.file +
        ':' +
        finding.line +
        '.',
      artifactHashes: [],
      recordedAt,
    })),
  };
}

export function normalizeProviderFindings(
  rawReview: unknown,
  lineIndex: DiffLineIndex,
  checks: DeterministicCheckRun,
  recordedAt: string,
): {
  findings: Finding[];
  rejections: FindingRejection[];
  invalid: boolean;
} {
  const review = parseModelReviewResponse(rawReview);
  const findings: Finding[] = [];
  const rejections: FindingRejection[] = [];
  const fingerprints = new Set<string>();
  let invalid = false;

  review.findings.forEach((rawFinding, index) => {
    let finding: Finding;
    try {
      finding = normalizeFinding(rawFinding);
    } catch {
      invalid = true;
      rejections.push({ index, reason: 'invalid_finding' });
      return;
    }

    const location = validateFindingLocation(finding, lineIndex);
    if (!location.valid) {
      invalid = true;
      rejections.push({ index, reason: location.reason });
      return;
    }
    if (fingerprints.has(finding.fingerprint)) {
      rejections.push({ index, reason: 'duplicate_fingerprint' });
      return;
    }

    fingerprints.add(finding.fingerprint);
    findings.push(attachDeterministicSupport(finding, checks, recordedAt));
  });

  return { findings, rejections, invalid };
}
