import type {
  CommandExecutionResult,
  Finding,
  ReviewVerdict,
} from '@walkz/contracts';
import {
  resolvePolicyPacks,
  type LocalReviewPipelineResult,
} from '@walkz/engine';

function outcomeLabel(outcome: CommandExecutionResult['outcome']): string {
  switch (outcome) {
    case 'succeeded':
      return 'PASS';
    case 'failed':
      return 'FAIL';
    case 'timed_out':
      return 'TIMEOUT';
    case 'cancelled':
      return 'CANCELLED';
    case 'spawn_error':
    case 'configuration_error':
      return 'ERROR';
  }
}

function findingLocation(finding: Finding): string {
  return (
    finding.file +
    ':' +
    finding.line +
    (finding.endLine === undefined ? '' : '-' + finding.endLine)
  );
}

export function mapVerdictToExitCode(
  verdict: ReviewVerdict,
): 0 | 1 | 2 | 3 {
  switch (verdict) {
    case 'SHIP':
      return 0;
    case 'FIX':
      return 1;
    case 'HUMAN':
    case 'INCONCLUSIVE':
      return 2;
    case 'ERROR':
      return 3;
  }
}

export function renderTerminalReport(
  result: LocalReviewPipelineResult,
): string {
  const lines = [
    'Walkz review',
    '',
    'Verdict: ' + result.decision.verdict,
    'Policy packs: ' +
      (resolvePolicyPacks(result.run.config).ids.join(', ') || 'none'),
  ];
  const references = result.context?.references;
  if (references !== undefined) {
    lines.push(
      'Base: ' + references.baseSha,
      'Head: ' + (references.headSha ?? 'INDEX'),
    );
  }

  const coverage = result.context?.coverage;
  if (coverage !== undefined) {
    lines.push(
      'Coverage: ' +
        (coverage.complete && !result.provider.promptTruncated
          ? 'complete'
          : 'incomplete') +
        ' (' +
        coverage.selectedFileCount +
        '/' +
        coverage.changedFileCount +
        ' files)',
    );
  }

  lines.push('', 'Checks:');
  const checks = result.deterministicChecks?.checks ?? [];
  if (checks.length === 0) {
    lines.push('  none');
  } else {
    for (const check of checks) {
      lines.push(
        '  ' +
          outcomeLabel(check.execution.outcome).padEnd(9) +
          ' ' +
          check.commandId,
      );
    }
  }

  lines.push('', 'Findings:');
  if (result.run.findings.length === 0) {
    lines.push('  none');
  } else {
    for (const finding of result.run.findings) {
      lines.push(
        '  [' +
          finding.evidenceLevel +
          '] ' +
          finding.severity +
          ' ' +
          findingLocation(finding),
        '    ' + finding.claim,
      );
    }
  }

  if (result.provider.failureCode !== null) {
    lines.push('', 'Provider: ' + result.provider.failureCode);
  } else if (result.provider.status === 'complete') {
    lines.push(
      '',
      'Provider: ' +
        result.provider.provider +
        ' / ' +
        result.provider.model,
    );
  }
  if (result.challenger.failureCode !== null) {
    lines.push('', 'Challenger: ' + result.challenger.failureCode);
  } else if (result.challenger.status === 'complete') {
    lines.push(
      '',
      'Challenger: ' +
        result.challenger.provider +
        ' / ' +
        result.challenger.model,
    );
  }
  if (result.security.failureCode !== null) {
    lines.push('', 'Security specialist: ' + result.security.failureCode);
  } else if (result.security.status === 'complete') {
    lines.push(
      '',
      'Security specialist: ' +
        result.security.provider +
        ' / ' +
        result.security.model,
    );
  }
  return lines.join('\n') + '\n';
}

export function renderJsonReport(
  result: LocalReviewPipelineResult,
): string {
  return (
    JSON.stringify(
      {
        runId: result.run.runId,
        status: result.run.status,
        verdict: result.decision.verdict,
        reasons: result.decision.reasons,
        baseSha: result.context?.references.baseSha ?? null,
        headSha: result.context?.references.headSha ?? null,
        headRef: result.context?.references.headRef ?? null,
        configHash: result.run.request.configHash,
        policyPacks: resolvePolicyPacks(result.run.config).ids,
        coverage: result.context?.coverage ?? null,
        deterministicChecks: result.deterministicChecks,
        findings: result.run.findings,
        provider: result.provider,
        challenger: result.challenger,
        security: result.security,
        startedAt: result.run.startedAt,
        completedAt: result.run.completedAt,
        failure: result.failure,
      },
      null,
      2,
    ) + '\n'
  );
}
