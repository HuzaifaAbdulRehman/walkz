import { isUtf8 } from 'node:buffer';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  parsePatchProposal,
  parsePatchReproofResult,
  type Finding,
  type PatchCandidate,
  type PatchProposal,
  type PatchReproofCheck,
  type PatchReproofResult,
  type ProofExecutionResult,
  type ProofPlan,
} from '@walkz/contracts';
import {
  assertProofWorkspacePath,
  withProofWorkspaces,
  type ProofWorkspace,
  type ProofWorkspaceLimits,
} from '@walkz/git';
import {
  executeProofInContainer,
  type ExecuteDockerProofOptions,
  type ProofExecutionPair,
} from '@walkz/sandbox';

import { verifyPatchCandidateIntegrity } from './patch-generation.js';
import { prepareApprovedPatchSuggestion } from './patch-publication.js';
import { assessCounterfactualProof } from './proof-evidence.js';
import {
  fingerprintProofPlan,
  verifyProofPlan,
  type ProofBudget,
  type ProofPlanAuthorization,
} from './proof-plan.js';

const maximumPatchFileBytes = 512 * 1_024;
const maximumRegressionPlans = 8;

export interface ApprovedPatchReproofInput {
  attempt: number;
  finding: Finding;
  proposal: unknown;
  candidate: unknown;
  proofPlan: unknown;
  originalExecution: ProofExecutionPair;
  regressionPlans?: readonly unknown[];
}

export interface RunApprovedPatchReproofOptions {
  repositoryRoot: string;
  authorization: ProofPlanAuthorization;
  budget: ProofBudget;
  workspaceLimits: ProofWorkspaceLimits;
  temporaryRoot?: string;
  signal?: AbortSignal;
  docker?: Omit<ExecuteDockerProofOptions, 'signal'>;
  now?: () => Date;
}

export interface ApprovedPatchReproofRun {
  result: PatchReproofResult;
  proofExecution: ProofExecutionResult;
  regressionExecutions: ProofExecutionResult[];
}

function sameDigest(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validateFinding(
  finding: Finding,
  proposal: PatchProposal,
  candidate: PatchCandidate,
): void {
  if (finding.lifecycleStatus !== 'verified' || finding.evidenceLevel !== 'VERIFIED') {
    throw new Error('Patch reproof requires a verified finding.');
  }
  const findingEndLine = finding.endLine ?? finding.line;
  if (
    finding.file !== candidate.path ||
    candidate.startLine > findingEndLine ||
    candidate.endLine < finding.line ||
    proposal.findingId !== candidate.findingId
  ) {
    throw new Error('Patch reproof candidate is not bound to the verified finding.');
  }
}

function validatePlanBinding(
  plan: ProofPlan,
  finding: Finding,
  proposal: PatchProposal,
): void {
  if (
    plan.runId !== proposal.reviewRunId ||
    !sameDigest(plan.findingFingerprint, finding.fingerprint) ||
    !sameDigest(plan.baseSha, proposal.baseSha) ||
    !sameDigest(plan.headSha, proposal.headSha)
  ) {
    throw new Error('Patch reproof plan does not match the approved proposal.');
  }
}

function containedWorkspaceFile(root: string, path: string): string {
  assertProofWorkspacePath(path);
  const target = resolve(root, ...path.split('/'));
  const fromRoot = relative(root, target);
  if (
    fromRoot.length === 0 ||
    fromRoot.startsWith('..') ||
    isAbsolute(fromRoot)
  ) {
    throw new Error('Patch reproof path escaped its workspace.');
  }
  return target;
}

function applyLineReplacement(
  content: string,
  candidate: Pick<PatchCandidate, 'startLine' | 'endLine' | 'replacement'>,
): string {
  const hasCrLf = content.includes('\r\n');
  const hasBareLf = content.replace(/\r\n/gu, '').includes('\n');
  if (hasCrLf && hasBareLf) {
    throw new Error('Patch reproof does not rewrite mixed line endings.');
  }
  const lineEnding = hasCrLf ? '\r\n' : '\n';
  const normalized = content.replace(/\r\n/gu, '\n');
  const hadFinalNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (hadFinalNewline) lines.pop();
  const replacement = candidate.replacement.endsWith('\n')
    ? candidate.replacement.slice(0, -1)
    : candidate.replacement;
  const replacementLines = replacement.length === 0 ? [] : replacement.split('\n');
  lines.splice(
    candidate.startLine - 1,
    candidate.endLine - candidate.startLine + 1,
    ...replacementLines,
  );
  const patched = lines.join('\n') + (hadFinalNewline ? '\n' : '');
  return lineEnding === '\r\n' ? patched.replace(/\n/gu, '\r\n') : patched;
}

async function applyApprovedPatch(
  workspace: ProofWorkspace,
  proposal: PatchProposal,
  candidate: PatchCandidate,
): Promise<void> {
  const root = await realpath(workspace.path);
  const target = containedWorkspaceFile(root, candidate.path);
  const resolvedTarget = await realpath(target);
  const resolvedFromRoot = relative(root, resolvedTarget);
  if (
    resolvedFromRoot.length === 0 ||
    resolvedFromRoot.startsWith('..') ||
    isAbsolute(resolvedFromRoot)
  ) {
    throw new Error('Patch reproof path resolved outside its workspace.');
  }
  const metadata = await lstat(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumPatchFileBytes) {
    throw new Error('Patch reproof accepts only bounded regular files.');
  }
  const bytes = await readFile(target);
  if (!isUtf8(bytes) || bytes.includes(0)) {
    throw new Error('Patch reproof accepts only UTF-8 text files.');
  }
  const content = bytes.toString('utf8');
  prepareApprovedPatchSuggestion({
    candidate,
    proposal,
    currentHeadSha: workspace.sha,
    headFile: { path: candidate.path, content },
  });
  await writeFile(target, applyLineReplacement(content, candidate), { flag: 'w' });
}

function checkFromExecution(
  kind: PatchReproofCheck['kind'],
  execution: ProofExecutionResult,
): PatchReproofCheck {
  return {
    kind,
    planDigest: execution.planDigest,
    commandDigest: execution.commandDigest,
    outcome: execution.outcome,
    exitCode: execution.exitCode,
    durationMs: execution.durationMs,
    sanitizedSummary: [execution.stdout.summary, execution.stderr.summary]
      .filter((value) => value.length > 0)
      .join('\n'),
    artifacts: execution.artifacts,
  };
}

function resultOutcome(checks: readonly PatchReproofCheck[]): PatchReproofResult['outcome'] {
  if (checks.some((check) => check.outcome === 'failed')) {
    return 'unresolved';
  }
  if (checks.some((check) =>
    check.outcome === 'timed_out' ||
    check.outcome === 'cancelled' ||
    check.outcome === 'infrastructure_error')) {
    return 'inconclusive';
  }
  return 'resolved';
}

function createTimedSignal(
  durationMs: number,
  externalSignal: AbortSignal | undefined,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  timer.unref();
  return {
    signal: externalSignal === undefined
      ? controller.signal
      : AbortSignal.any([externalSignal, controller.signal]),
    dispose: () => clearTimeout(timer),
  };
}

export async function runApprovedPatchReproof(
  input: ApprovedPatchReproofInput,
  options: RunApprovedPatchReproofOptions,
): Promise<ApprovedPatchReproofRun> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 100) {
    throw new Error('Patch reproof attempt must be between 1 and 100.');
  }
  const candidate = verifyPatchCandidateIntegrity(input.candidate);
  const proposal = parsePatchProposal(input.proposal);
  validateFinding(input.finding, proposal, candidate);

  const proofPlan = verifyProofPlan(
    input.proofPlan,
    options.authorization,
    options.budget,
  );
  validatePlanBinding(proofPlan, input.finding, proposal);
  const original = assessCounterfactualProof(
    input.finding,
    proofPlan,
    input.originalExecution,
  );
  if (original.classification !== 'verified') {
    throw new Error('Patch reproof requires an originally verified proof pair.');
  }

  const regressionInputs = input.regressionPlans ?? [];
  if (
    regressionInputs.length > maximumRegressionPlans ||
    regressionInputs.length + 1 > options.budget.maxAttempts
  ) {
    throw new Error('Patch reproof checks exceed the allocated attempt budget.');
  }
  const regressionPlans = regressionInputs.map((planInput) => {
    const plan = verifyProofPlan(planInput, options.authorization, options.budget);
    validatePlanBinding(plan, input.finding, proposal);
    return plan;
  });

  const deadlineRemainingMs = options.budget.deadlineMs - Date.now();
  if (deadlineRemainingMs <= 0) {
    throw new Error('Patch reproof budget deadline has been reached.');
  }
  const deadlineSignal = createTimedSignal(deadlineRemainingMs, options.signal);
  let executions: {
    proofExecution: ProofExecutionResult;
    regressionExecutions: ProofExecutionResult[];
  };
  try {
    executions = await withProofWorkspaces({
      repositoryRoot: options.repositoryRoot,
      baseSha: proofPlan.baseSha,
      headSha: proofPlan.headSha,
      limits: options.workspaceLimits,
      ...(options.temporaryRoot === undefined ? {} : { temporaryRoot: options.temporaryRoot }),
      signal: deadlineSignal.signal,
    }, async ({ head }) => {
      await applyApprovedPatch(head, proposal, candidate);
      const executionSignal = createTimedSignal(
        options.budget.maxTotalDurationMs,
        deadlineSignal.signal,
      );
      try {
        const dockerOptions = {
          ...options.docker,
          signal: executionSignal.signal,
        };
        const proofExecution = await executeProofInContainer(
          proofPlan,
          fingerprintProofPlan(proofPlan),
          head,
          dockerOptions,
        );
        const regressionExecutions: ProofExecutionResult[] = [];
        for (const plan of regressionPlans) {
          if (proofExecution.outcome !== 'passed') break;
          regressionExecutions.push(await executeProofInContainer(
            plan,
            fingerprintProofPlan(plan),
            head,
            dockerOptions,
          ));
        }
        return { proofExecution, regressionExecutions };
      } finally {
        executionSignal.dispose();
      }
    });
  } finally {
    deadlineSignal.dispose();
  }

  const proof = checkFromExecution('proof', executions.proofExecution);
  const regressions = executions.regressionExecutions.map((execution) =>
    checkFromExecution('regression', execution));
  const result = parsePatchReproofResult({
    schemaVersion: 1,
    proposalId: proposal.id,
    reviewRunId: proposal.reviewRunId,
    findingId: proposal.findingId,
    attempt: input.attempt,
    patchHash: proposal.patchHash,
    headSha: proposal.headSha,
    outcome: resultOutcome([proof, ...regressions]),
    proof,
    regressions,
    recordedAt: (options.now?.() ?? new Date()).toISOString(),
  });
  return {
    result,
    proofExecution: executions.proofExecution,
    regressionExecutions: executions.regressionExecutions,
  };
}
