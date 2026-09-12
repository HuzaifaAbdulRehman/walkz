import {
  parseWalkzConfig,
  type ProofPlan,
  type RepositoryConfig,
} from '@walkz/contracts';

import {
  createProofPlan,
  digestProofCommand,
  fingerprintProofPlan,
  type ProofBudget,
  type ProofPlanAuthorization,
} from './proof-plan.js';

const maximumProofTimeoutMs = 5 * 60 * 1_000;
const maximumReproofDurationMs = 15 * 60 * 1_000;
const maximumProofOutputBytes = 1024 * 1_024;
const maximumWritableBytes = 64 * 1_024 * 1_024;

export interface PatchProofBindingInput {
  reviewRunId: string;
  findingFingerprint: string;
  baseSha: string;
  headSha: string;
  commandDigest: string;
  containerImage: string;
  config: RepositoryConfig;
}

export interface BoundPatchProof {
  plan: ProofPlan;
  planDigest: string;
  regressionPlans: ProofPlan[];
  authorization: ProofPlanAuthorization;
  limits: {
    timeoutMs: number;
    maxOutputBytesPerStream: number;
    maxWritableBytes: number;
  };
}

export function bindPatchProofToRepositoryCommand(
  input: PatchProofBindingInput,
): BoundPatchProof {
  const config = parseWalkzConfig(input.config);
  if (config.commandApprovalPolicy !== 'trusted_config') {
    throw new Error('Hosted patch proof requires a trusted repository command.');
  }
  const commandDigest = input.commandDigest.toLowerCase();
  const commands = config.commands.map(({ executable, args, cwd, required }) => {
    const command = { executable, args, cwd };
    return { command, digest: digestProofCommand(command), required };
  });
  const proofCommand = commands.find((candidate) => candidate.digest === commandDigest);
  if (proofCommand === undefined) {
    throw new Error('The original proof command is no longer authorized.');
  }
  const regressionDigests = new Set<string>();
  const regressionCommands = commands.filter((candidate) => {
    if (!candidate.required || candidate.digest === commandDigest ||
      regressionDigests.has(candidate.digest)) {
      return false;
    }
    regressionDigests.add(candidate.digest);
    return true;
  });
  const timeoutMs = Math.min(config.commandTimeoutMs, maximumProofTimeoutMs);
  const maxOutputBytesPerStream = Math.min(
    config.commandOutputBytesPerStream,
    maximumProofOutputBytes,
  );
  const authorization = {
    authorizedCommandDigests: new Set([
      commandDigest,
      ...regressionCommands.map((candidate) => candidate.digest),
    ]),
  };
  const limits = {
    timeoutMs,
    maxOutputBytesPerStream,
    maxWritableBytes: maximumWritableBytes,
  };
  const maxAttempts = 1 + regressionCommands.length;
  const maxTotalDurationMs = Math.min(
    timeoutMs * maxAttempts,
    maximumReproofDurationMs,
  );
  const planningBudget: ProofBudget = {
    maxAttempts,
    maxTotalDurationMs,
    maxAttemptDurationMs: timeoutMs,
    maxOutputBytesPerStream,
    maxArtifactBytes: maximumWritableBytes,
    deadlineMs: Number.MAX_SAFE_INTEGER,
  };
  const createBoundPlan = (command: ProofPlan['command']): ProofPlan =>
    createProofPlan({
      runId: input.reviewRunId,
      findingFingerprint: input.findingFingerprint,
      baseSha: input.baseSha,
      headSha: input.headSha,
      containerImage: input.containerImage,
      command,
      limits: {
        timeoutMs,
        maxOutputBytesPerStream,
        memoryBytes: 512 * 1_024 * 1_024,
        nanoCpus: 1_000_000_000,
        pidsLimit: 64,
        maxWritableBytes: maximumWritableBytes,
      },
    }, authorization, planningBudget);
  const plan = createBoundPlan(proofCommand.command);
  const regressionPlans = regressionCommands.map((candidate) =>
    createBoundPlan(candidate.command));
  return {
    plan,
    planDigest: fingerprintProofPlan(plan),
    regressionPlans,
    authorization,
    limits,
  };
}

export function createPatchReproofBudget(
  binding: BoundPatchProof,
  nowMs = Date.now(),
): ProofBudget {
  const maxTotalDurationMs = Math.min(
    binding.limits.timeoutMs * (1 + binding.regressionPlans.length),
    maximumReproofDurationMs,
  );
  return {
    maxAttempts: 1 + binding.regressionPlans.length,
    maxTotalDurationMs,
    maxAttemptDurationMs: binding.limits.timeoutMs,
    maxOutputBytesPerStream: binding.limits.maxOutputBytesPerStream,
    maxArtifactBytes: binding.limits.maxWritableBytes,
    deadlineMs: nowMs + maxTotalDurationMs,
  };
}
