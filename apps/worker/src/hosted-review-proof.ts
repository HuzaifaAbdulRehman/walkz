import { createHash } from 'node:crypto';

import type {
  CommandExecutionResult,
  DeterministicCheckRun,
  Finding,
  ProofExecutionResult,
  RepositoryConfig,
} from '@walkz/contracts';
import {
  bindPatchProofToRepositoryCommand,
  createPatchReproofBudget,
  createProofPlan,
  digestProofCommand,
  fingerprintProofPlan,
  runAndAssessCounterfactualProof,
} from '@walkz/engine';
import {
  executeProofInContainer,
  runDeterministicChecks,
  type DockerWorkspaceVolume,
} from '@walkz/sandbox';

const maximumProofTimeoutMs = 5 * 60 * 1_000;
const maximumProofOutputBytes = 1_024 * 1_024;
const maximumReviewProofDurationMs = 10 * 60 * 1_000;
const maximumWritableBytes = 64 * 1_024 * 1_024;
const maximumFindingProofAttempts = 3;

type ExecuteProof = typeof executeProofInContainer;
type RunProof = typeof runAndAssessCounterfactualProof;

export interface HostedReviewProofContext {
  reviewRunId: string;
  baseSha: string;
  headSha: string;
  proofImage: string;
  repositoryRoot: string;
  config: RepositoryConfig;
  signal?: AbortSignal;
  workspaceVolume?: DockerWorkspaceVolume;
}

function commandExecution(result: ProofExecutionResult): CommandExecutionResult {
  const requested = result.outcome === 'timed_out'
    ? 'timeout'
    : result.outcome === 'cancelled'
      ? 'cancelled'
      : null;
  return {
    outcome: result.outcome === 'passed'
      ? 'succeeded'
      : result.outcome === 'infrastructure_error'
        ? 'spawn_error'
        : result.outcome,
    exitCode: result.exitCode,
    signal: null,
    durationMs: result.durationMs,
    stdout: { ...result.stdout, text: result.stdout.summary },
    stderr: { ...result.stderr, text: result.stderr.summary },
    termination: {
      requested,
      accepted: requested !== null,
      guarantee: 'best_effort',
    },
    ...(result.outcome === 'infrastructure_error'
      ? { errorMessage: 'The locked check container could not run.' }
      : {}),
  };
}

export async function runHostedDeterministicChecks(
  context: HostedReviewProofContext,
  executeProof: ExecuteProof = executeProofInContainer,
): Promise<DeterministicCheckRun> {
  const timeoutMs = Math.min(context.config.commandTimeoutMs, maximumProofTimeoutMs);
  const maxOutputBytesPerStream = Math.min(
    context.config.commandOutputBytesPerStream,
    maximumProofOutputBytes,
  );
  const maxAttempts = Math.max(1, context.config.commands.length);
  const maxTotalDurationMs = Math.min(
    timeoutMs * maxAttempts,
    maximumReviewProofDurationMs,
  );
  const authorization = {
    authorizedCommandDigests: new Set(context.config.commands.map((command) =>
      digestProofCommand({
        executable: command.executable,
        args: command.args,
        cwd: command.cwd,
      }))),
  };
  const budget = {
    maxAttempts,
    maxTotalDurationMs,
    maxAttemptDurationMs: timeoutMs,
    maxOutputBytesPerStream,
    maxArtifactBytes: maximumWritableBytes,
    deadlineMs: Date.now() + maxTotalDurationMs,
  };
  const findingFingerprint = createHash('sha256')
    .update(`${context.reviewRunId}:hosted-checks`, 'utf8')
    .digest('hex');

  return runDeterministicChecks(context.config, context.repositoryRoot, {
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    executor: async (spec) => {
      const plan = createProofPlan({
        runId: context.reviewRunId,
        findingFingerprint,
        baseSha: context.baseSha,
        headSha: context.headSha,
        containerImage: context.proofImage,
        command: {
          executable: spec.executable,
          args: [...spec.args],
          cwd: spec.cwd ?? '.',
        },
        limits: {
          timeoutMs,
          maxOutputBytesPerStream,
          memoryBytes: 512 * 1_024 * 1_024,
          nanoCpus: 1_000_000_000,
          pidsLimit: 64,
          maxWritableBytes: maximumWritableBytes,
        },
      }, authorization, budget);
      const execution = await executeProof(
        plan,
        fingerprintProofPlan(plan),
        {
          revision: 'head',
          sha: context.headSha,
          path: context.repositoryRoot,
        },
        {
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(context.workspaceVolume === undefined
            ? {}
            : { workspaceVolume: context.workspaceVolume }),
        },
      );
      return commandExecution(execution);
    },
  });
}

export async function proveHostedFindings(
  findings: readonly Finding[],
  context: HostedReviewProofContext,
  runProof: RunProof = runAndAssessCounterfactualProof,
): Promise<{
  findings: Finding[];
  proofStatus: 'complete' | 'not_requested' | 'incomplete';
}> {
  const updated = [...findings];
  let attempts = 0;
  let requested = false;
  let incomplete = false;

  for (const [index, original] of updated.entries()) {
    if (original.lifecycleStatus !== 'supported' || original.evidenceLevel !== 'SUPPORTED') {
      continue;
    }
    requested = true;
    let finding = original;
    const commandDigests = [...new Set(original.evidence
      .filter((evidence) =>
        evidence.kind === 'deterministic_check' && evidence.headOutcome === 'failed')
      .map((evidence) => evidence.commandDigest))];
    if (commandDigests.length === 0) {
      incomplete = true;
      continue;
    }

    for (const commandDigest of commandDigests) {
      if (attempts >= maximumFindingProofAttempts) {
        incomplete = true;
        break;
      }
      attempts += 1;
      let binding;
      try {
        binding = bindPatchProofToRepositoryCommand({
          reviewRunId: context.reviewRunId,
          findingFingerprint: finding.fingerprint,
          baseSha: context.baseSha,
          headSha: context.headSha,
          commandDigest,
          containerImage: context.proofImage,
          config: context.config,
        });
      } catch {
        incomplete = true;
        break;
      }
      const proof = await runProof(finding, binding.plan, {
        repositoryRoot: context.repositoryRoot,
        authorization: binding.authorization,
        budget: createPatchReproofBudget(binding),
        workspaceLimits: {
          maxFiles: 20_000,
          maxBytes: 256 * 1_024 * 1_024,
          gitTimeoutMs: 60_000,
        },
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(context.workspaceVolume === undefined
          ? {}
          : {
              temporaryRoot: context.workspaceVolume.root,
              docker: { workspaceVolume: context.workspaceVolume },
            }),
      });
      finding = proof.assessment.finding;
      if (proof.assessment.proofStatus === 'incomplete') {
        incomplete = true;
        break;
      }
      if (proof.assessment.classification === 'verified') break;
    }
    updated[index] = finding;
  }

  return {
    findings: updated,
    proofStatus: !requested
      ? 'not_requested'
      : incomplete
        ? 'incomplete'
        : 'complete',
  };
}
